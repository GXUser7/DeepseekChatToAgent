import sys
import json
import os
import requests
import subprocess
import time
import re
import threading
import queue

BACKGROUND_PROCESSES = []
GLOBAL_PARENT_MESSAGE_ID = None

def reader_thread_func(stream, q):
    try:
        for line in iter(stream.readline, ''):
            if not line:
                break
            q.put(line)
    except Exception:
        pass
    finally:
        try:
            stream.close()
        except Exception:
            pass


if sys.platform.startswith('win'):
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
    os.system("chcp 65001 > nul")

# ANSI Color Codes for beautiful terminal styling
class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'
    DARK_GRAY = '\033[90m'

def get_base_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        return os.path.dirname(os.path.abspath(__file__))

def get_resource_path(relative_path):
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, relative_path)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), relative_path)

CONFIG_FILE = os.path.join(get_base_dir(), "config.json")

SYSTEM_INIT_PROMPT = """Ты — локальная LLM-модель с доступом только к терминалу.

Твоя задача:

* выполнять запросы пользователя через терминал,
* анализировать результаты команд,
* писать код,
* изменять файлы,
* работать автономно и пошагово.

КРИТИЧЕСКИ ВАЖНО:
Ты можешь выполнять только ОДНО действие за один ответ.

Если требуется выполнить команду терминала, твой ответ ДОЛЖЕН содержать ТОЛЬКО:

<terminal>команда</terminal>

Пример: <terminal>ls -la</terminal>

НЕПРАВИЛЬНО:

* текст до тегов,
* текст после тегов,
* markdown,
* пояснения,
* комментарии,
* несколько команд,
* кодовые блоки.

Если в ответе есть <terminal>, система полностью игнорирует любой другой текст.

Правила работы:

1. Не объясняй свои действия перед выполнением команды.
2. Не описывай план.
3. Не рассуждай вслух.
4. Не пиши chain-of-thought.
5. Если информации недостаточно — задай короткий уточняющий вопрос обычным текстом.
6. Не выдумывай результаты выполнения команд.
7. После получения результата команды анализируй его и выбирай следующее действие.
8. Для сложных задач используй последовательность отдельных terminal-вызовов.
9. Если пользователь просит написать код:

* не задавай лишних вопросов,
* создай минимально рабочее решение,
* если путь не указан — создай файл в текущей директории.

10. При изменении файлов сначала изучай существующий код.
11. Избегай опасных команд без необходимости.
12. Никогда не симулируй выполнение терминала. Человечество уже достаточно настрадалось от ИИ, который с важным видом придумывает несуществующие результаты.

После этого сообщения будет передан запрос пользователя.

Запрос пользователя:
привет"""

def print_header(title):
    print(f"\n{Colors.BLUE}{Colors.BOLD}{'=' * 60}")
    print(f" {title.center(58)}")
    print(f"{Colors.BLUE}{'=' * 60}{Colors.ENDC}\n")

def load_config():
    if not os.path.exists(CONFIG_FILE):
        print(f"{Colors.WARNING}[Конфигурация не найдена] Запуск автоматической авторизации через Selenium...{Colors.ENDC}")
        import auth_fetcher
        success = auth_fetcher.fetch_tokens_and_save()
        if not success:
            print(f"{Colors.FAIL}[Ошибка] Не удалось получить токены авторизации. Завершение работы.{Colors.ENDC}")
            sys.exit(1)
        
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"{Colors.FAIL}[Ошибка]{Colors.ENDC} Не удалось загрузить {CONFIG_FILE}: {e}")
        sys.exit(1)

def get_last_message_id(config):
    url = f"https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id={config.get('chat_session_id')}"
    headers = {
        "authorization": config.get("authorization"),
        "cookie": config.get("cookie"),
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "accept": "application/json"
    }
    try:
        res = requests.get(url, headers=headers, timeout=15)
        if res.status_code == 200:
            res_json = res.json()
            code = res_json.get("code", 0)
            if code in (401, 40001):
                print(f"{Colors.WARNING}[Авторизация]{Colors.ENDC} Ответ сервера code={code}: токен истек.")
                return None, False
            biz_data = res_json.get("data", {}).get("biz_data", {})
            return biz_data.get("chat_session", {}).get("current_message_id"), True
        elif res.status_code in (401, 403):
            print(f"{Colors.WARNING}[Авторизация]{Colors.ENDC} Статус {res.status_code}: токен недействителен.")
            return None, False
        else:
            print(f"{Colors.WARNING}[Предупреждение]{Colors.ENDC} Сервер вернул код {res.status_code}")
            return None, True  # Assume authenticated, but got some other response (e.g. rate limit/maintenance)
    except Exception as e:
        print(f"{Colors.WARNING}[Предупреждение]{Colors.ENDC} Ошибка сети при проверке токена: {e}")
        return None, True  # Assume auth is okay, don't trigger Chrome on connection loss


def solve_pow_challenge(config):
    challenge_url = "https://chat.deepseek.com/api/v0/chat/create_pow_challenge"
    
    headers = {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9,ru-RU;q=0.8,ru;q=0.7",
        "authorization": config.get("authorization"),
        "content-type": "application/json",
        "cookie": config.get("cookie"),
        "origin": "https://chat.deepseek.com",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "x-app-version": "2.0.0",
        "x-client-locale": "en_US",
        "x-client-platform": "web",
    }
    
    try:
        print(f"{Colors.BLUE}[Получение PoW вызова...]{Colors.ENDC}", end="", flush=True)
        res = requests.post(challenge_url, headers=headers, json={"target_path": "/api/v0/chat/completion"}, timeout=15)
        if res.status_code != 200:
            print(f" {Colors.FAIL}[Ошибка {res.status_code}]{Colors.ENDC}")
            return None
        
        challenge_res = res.json()
        biz_data = challenge_res.get("data", {}).get("biz_data", {})
        challenge_config = biz_data.get("challenge", {})
        if not challenge_config:
            print(f" {Colors.FAIL}[Неверный формат]{Colors.ENDC}")
            return None
            
        print(f" {Colors.GREEN}[Успешно]{Colors.ENDC}")
        print(f"{Colors.BLUE}[Решение PoW (WASM)...]{Colors.ENDC}", end="", flush=True)
        
        pow_solver_js = get_resource_path("pow_solver.js")
        
        if not os.path.exists(pow_solver_js):
            print(f" {Colors.FAIL}[Файл pow_solver.js не найден]{Colors.ENDC}")
            return None
            
        pow_solver_dir = os.path.dirname(pow_solver_js)
        input_json = json.dumps(challenge_config)
        start = time.time()
        result = subprocess.run(
            ["node", pow_solver_js, input_json],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=pow_solver_dir
        )
        elapsed = time.time() - start
        
        if result.returncode != 0:
            print(f" {Colors.FAIL}[Ошибка Node.js]{Colors.ENDC}")
            print(f"{Colors.DARK_GRAY}Stderr: {result.stderr.strip()}{Colors.ENDC}")
            return None
            
        pow_response = result.stdout.strip()
        print(f" {Colors.GREEN}[Решено за {elapsed:.2f} сек.]{Colors.ENDC}")
        return pow_response
        
    except Exception as e:
        print(f" {Colors.FAIL}[Ошибка: {e}]{Colors.ENDC}")
        return None

def extract_terminal_command(text):
    match = re.search(r'<terminal>(.*?)</terminal>', text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return None

def execute_terminal_command(command):
    command = command.strip()
    cwd_before = os.getcwd()
    print(f"\n{Colors.BLUE}[Исполнение команды в терминале]{Colors.ENDC}")
    print(f"{Colors.DARK_GRAY}[{cwd_before}]> {command}{Colors.ENDC}\n")
    return execute_terminal_command_with_callback(command)

def execute_terminal_command_with_callback(command, callback=None):
    command = command.strip()
    
    # 1. Parse for cd commands (both simple and compound)
    cd_compound_match = re.match(r'^cd\s+("([^"]+)"|\'([^\']+)\'|([^\s&;|]+))\s*(&&|;|;|&)\s*(.*)$', command, re.IGNORECASE)
    cd_simple_match = re.match(r'^cd\s*("([^"]+)"|\'([^\']+)\'|(.*))?$', command, re.IGNORECASE)
    
    target_path = None
    remaining_command = None
    
    if cd_compound_match:
        quoted_double = cd_compound_match.group(2)
        quoted_single = cd_compound_match.group(3)
        unquoted = cd_compound_match.group(4)
        target_path = quoted_double or quoted_single or unquoted
        remaining_command = cd_compound_match.group(6).strip()
    elif cd_simple_match:
        quoted_double = cd_simple_match.group(2)
        quoted_single = cd_simple_match.group(3)
        unquoted = cd_simple_match.group(4)
        target_path = quoted_double or quoted_single or unquoted
        if target_path:
            target_path = target_path.strip()
        else:
            target_path = "" # Go to home directory
            
    # 2. Parse for drive changes on Windows (e.g. "D:" or "d:")
    elif sys.platform.startswith('win') and re.match(r'^[a-zA-Z]:$', command):
        target_path = command
        
    if target_path is not None:
        if not target_path or target_path == "~":
            target_path = os.path.expanduser("~")
            
        try:
            os.chdir(target_path)
            new_cwd = os.getcwd()
            print(f"{Colors.GREEN}[CWD] Рабочая директория успешно изменена на: {new_cwd}{Colors.ENDC}")
            if callback:
                callback(f"[CWD] Изменен на {new_cwd}\n")
            
            if remaining_command:
                return execute_subprocess_only_with_callback(remaining_command, callback)
            else:
                return f"[Успешно: Рабочая директория изменена на {new_cwd}]\n"
        except Exception as e:
            print(f"{Colors.FAIL}[CWD] Ошибка смены директории: {e}{Colors.ENDC}")
            return f"[Ошибка смены директории: {e}]\n"
            
    return execute_subprocess_only_with_callback(command, callback)

def execute_subprocess_only(command):
    return execute_subprocess_only_with_callback(command)

def execute_subprocess_only_with_callback(command, callback=None):
    try:
        current_cwd = os.getcwd()
        
        if sys.platform.startswith('win'):
            args = ["powershell", "-Command", command]
            shell_name = "Windows PowerShell"
        else:
            args = command
            shell_name = "Bash"
            
        print(f"{Colors.DARK_GRAY}[Запуск процесса...]{Colors.ENDC}")
        
        process = subprocess.Popen(
            args,
            shell=not sys.platform.startswith('win'),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding='utf-8',
            errors='ignore',
            cwd=current_cwd
        )
        
        q = queue.Queue()
        t = threading.Thread(target=reader_thread_func, args=(process.stdout, q))
        t.daemon = True
        t.start()
        
        start_time = time.time()
        stdout_err_content = []
        last_line_len = 0
        
        while True:
            poll_res = process.poll()
            
            while not q.empty():
                try:
                    line = q.get_nowait()
                    stdout_err_content.append(line)
                    
                    # Console dynamic line display: overwrite previous line using \r
                    stripped_line = line.strip()
                    if stripped_line:
                        display_line = stripped_line[:76] + "..." if len(stripped_line) > 76 else stripped_line
                        clear_padding = " " * max(0, last_line_len - len(display_line))
                        print(f"\r{Colors.DARK_GRAY}[вывод]{Colors.ENDC} {display_line}{clear_padding}", end="", flush=True)
                        last_line_len = len(display_line)
                        
                    if callback:
                        callback(line)
                except queue.Empty:
                    break
                    
            if poll_res is not None:
                break
                
            # If command exceeds 15 seconds, move it to the background!
            if time.time() - start_time > 15:
                print("\r" + " " * (last_line_len + 15) + "\r", end="", flush=True)
                print(f"\n{Colors.GREEN}[Процесс работает в фоновом режиме. Возврат управления через 15 сек...]{Colors.ENDC}\n")
                BACKGROUND_PROCESSES.append(process)
                
                full_log = "".join(stdout_err_content)
                output_msg = f"[Успешно: Команда запущена и продолжает работу в фоновом режиме в {shell_name}]\n"
                if full_log:
                    output_msg += f"--- ВЫВОД ЗА 15 СЕКУНД ---\n{full_log}\n"
                return output_msg
                
            time.sleep(0.05)
            
        print("\r" + " " * (last_line_len + 15) + "\r", end="", flush=True)
        exit_code = process.returncode
        full_log = "".join(stdout_err_content)
        
        if full_log:
            print(f"{Colors.BLUE}[Команда завершена с кодом {exit_code}]{Colors.ENDC}\n")
            
        output_msg = f"[Результат выполнения команды в {shell_name} (exit code: {exit_code})]\n"
        if full_log:
            output_msg += f"--- ВЫВОД ---\n{full_log}\n"
        else:
            output_msg += "(Команда выполнена успешно, вывода нет)\n"
            
        return output_msg
        
    except Exception as e:
        print(f"\n{Colors.FAIL}[Ошибка запуска команды: {e}]{Colors.ENDC}\n")
        return f"[Ошибка запуска команды: {e}]\n"


def parse_prompt_options(prompt):
    search_enabled = False
    model_type = "default"
    
    while True:
        stripped = False
        prompt_strip = prompt.strip()
        
        # Check /s or /search
        if prompt_strip.startswith("/s ") or prompt_strip == "/s":
            search_enabled = True
            prompt = prompt_strip[3:].strip()
            stripped = True
        elif prompt_strip.startswith("/search ") or prompt_strip == "/search":
            search_enabled = True
            prompt = prompt_strip[8:].strip()
            stripped = True
            
        # Check /e or /expert
        elif prompt_strip.startswith("/e ") or prompt_strip == "/e":
            model_type = "expert"
            prompt = prompt_strip[3:].strip()
            stripped = True
        elif prompt_strip.startswith("/expert ") or prompt_strip == "/expert":
            model_type = "expert"
            prompt = prompt_strip[8:].strip()
            stripped = True
            
        if not stripped:
            break
            
    return prompt, search_enabled, model_type


def send_chat_completion(config, prompt, parent_message_id, search_enabled=False, model_type="default", sse_callback=None):
    url = "https://chat.deepseek.com/api/v0/chat/completion"
    
    if sse_callback:
        sse_callback({"type": "status", "content": "Решение PoW вызова..."})
        
    pow_response = solve_pow_challenge(config)
    if not pow_response:
        print(f"{Colors.WARNING}[Предупреждение]{Colors.ENDC} Автоматическое решение PoW не удалось. Попробуем использовать токен из config.json...")
        pow_response = config.get("x_ds_pow_response") or config.get("x_ds_pow-response")
        
    if not pow_response:
        print(f"{Colors.FAIL}[Ошибка]{Colors.ENDC} Отсутствует x-ds-pow-response. Убедитесь, что Node.js установлен и pow_solver.js/sha3_wasm_bg.wasm присутствуют.")
        return None
        
    headers = {
        "accept": "*/*",
        "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "authorization": config.get("authorization"),
        "content-type": "application/json",
        "cookie": config.get("cookie"),
        "origin": "https://chat.deepseek.com",
        "priority": "u=1, i",
        "referer": f"https://chat.deepseek.com/a/chat/s/{config.get('chat_session_id')}",
        "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "x-app-version": "2.0.0",
        "x-client-locale": "en_US",
        "x-client-platform": "web",
        "x-client-timezone-offset": "18000",
        "x-client-version": "2.0.0",
        "x-ds-pow-response": pow_response
    }

    payload = {
        "chat_session_id": config.get("chat_session_id"),
        "parent_message_id": parent_message_id,
        "model_type": None,
        "prompt": prompt,
        "ref_file_ids": [],
        "thinking_enabled": True,
        "search_enabled": search_enabled,
        "action": None,
        "preempt": False
    }

    try:
        if sse_callback:
            sse_callback({"type": "status", "content": "Отправка запроса в DeepSeek..."})
            
        print(f"{Colors.BLUE}[Отправка запроса...]{Colors.ENDC}", end="", flush=True)
        response = requests.post(url, headers=headers, json=payload, stream=True, timeout=30)
        print(f" {Colors.GREEN}[Ответ получен. Статус: {response.status_code}]{Colors.ENDC}")
        
        if response.status_code == 403:
            print(f"{Colors.FAIL}[Ошибка 403]{Colors.ENDC} Доступ запрещен. Cookie или Authorization токен устарели.")
            return None
        elif response.status_code != 200:
            err_text = response.text
            print(f"{Colors.FAIL}[Ошибка {response.status_code}]{Colors.ENDC} Ответ сервера: {err_text}")
            if "server is busy" in err_text.lower() or "server_busy" in err_text.lower() or "busy" in err_text.lower():
                print(f"\n{Colors.WARNING}[Сервер занят]{Colors.ENDC} Ожидание 5 секунд перед автоматической отправкой \"продолжай\"...")
                time.sleep(5)
                return "server_busy"
            return None
            
        print(f"{Colors.DARK_GRAY}[DeepSeek обрабатывает запрос...]{Colors.ENDC}")
        if sse_callback:
            sse_callback({"type": "status", "content": "Получение ответа..."})
        
        active_path = None
        first_text_printed = False
        new_parent_id = None
        full_response = ""
        current_frag_type = None  # To differentiate THINK vs RESPONSE
        
        for line in response.iter_lines():
            if not line:
                continue
            line_str = line.decode('utf-8').strip()
            
            # Save raw logs for debugging and analysis
            try:
                log_path = os.path.join(get_base_dir(), "stream_debug.log")
                with open(log_path, "a", encoding="utf-8") as f_debug:
                    f_debug.write(line_str + "\n")
            except Exception:
                pass
            
            if line_str.startswith('data: '):
                data_content = line_str[len('data: '):].strip()
                if data_content == '[DONE]':
                    break
                    
                try:
                    data = json.loads(data_content)
                except json.JSONDecodeError:
                    continue
                
                # Check for stream completion indicator (FINISHED status)
                is_finished = False
                if isinstance(data, dict):
                    if data.get("p") == "response/status" and data.get("v") == "FINISHED":
                        is_finished = True
                    elif data.get("p") == "response" and data.get("o") == "BATCH" and isinstance(data.get("v"), list):
                        for item in data["v"]:
                            if isinstance(item, dict) and item.get("p") in ("quasi_status", "status") and item.get("v") == "FINISHED":
                                is_finished = True
                                break
                    elif isinstance(data.get("v"), dict) and data["v"].get("response", {}).get("status") == "FINISHED":
                        is_finished = True
                
                if is_finished:
                    break
                
                if "type" in data and data["type"] == "error":
                    err_msg = data.get('content') or ""
                    print(f"\n{Colors.FAIL}[Ошибка DeepSeek]{Colors.ENDC} {err_msg}")
                    if "server is busy" in err_msg.lower() or "server_busy" in err_msg.lower() or "busy" in err_msg.lower():
                        print(f"\n{Colors.WARNING}[Сервер занят]{Colors.ENDC} Ожидание 5 секунд перед автоматической отправкой \"продолжай\"...")
                        time.sleep(5)
                        return "server_busy"
                    return None
                
                if "response_message_id" in data:
                    new_parent_id = data["response_message_id"]
                
                if "p" in data:
                    active_path = data["p"]
                
                # Recursively check for fragment types in the JSON structure
                def find_frag_types(obj):
                    types = []
                    if isinstance(obj, dict):
                        if "type" in obj and isinstance(obj["type"], str):
                            types.append(obj["type"])
                        for k, v in obj.items():
                            types.extend(find_frag_types(v))
                    elif isinstance(obj, list):
                        for item in obj:
                            types.extend(find_frag_types(item))
                    return types
                
                found_types = find_frag_types(data)
                for t in found_types:
                    if t in ("THINK", "RESPONSE"):
                        current_frag_type = t
                
                # Check for direct RESPONSE fragment append with initial content
                if "p" in data and data["p"] == "response/fragments" and data.get("o") == "APPEND" and isinstance(data.get("v"), list):
                    for frag in data["v"]:
                        if isinstance(frag, dict) and frag.get("type") == "RESPONSE":
                            current_frag_type = "RESPONSE"
                            initial_content = frag.get("content")
                            if initial_content:
                                if not first_text_printed:
                                    print(f"{Colors.GREEN}{Colors.BOLD}DeepSeek:{Colors.ENDC} ", end="", flush=True)
                                    first_text_printed = True
                                print(initial_content, end="", flush=True)
                                full_response += initial_content
                                if sse_callback:
                                    sse_callback({"type": "response", "content": initial_content})
                
                # Check for TOOL_SEARCH start inside batch response
                if "v" in data and isinstance(data["v"], list):
                    for item in data["v"]:
                        if isinstance(item, dict) and item.get("p") == "fragments" and item.get("o") == "APPEND":
                            for frag in item.get("v", []):
                                if isinstance(frag, dict) and frag.get("type") == "TOOL_SEARCH":
                                    queries = frag.get("queries", [])
                                    if queries:
                                        print(f"\n{Colors.CYAN}{Colors.BOLD}[Поиск в сети]{Colors.ENDC} Запросы:")
                                        for q in queries:
                                            query_text = q.get("query")
                                            if query_text:
                                                print(f"  🔍 \"{query_text}\"")
                                        print()
                                        if sse_callback:
                                            sse_callback({"type": "search_queries", "queries": queries})
                
                # Check for search results setting
                if active_path == "response/fragments/-1/results" and "v" in data and isinstance(data["v"], list):
                    print(f"{Colors.CYAN}{Colors.BOLD}[Анализ результатов поиска]{Colors.ENDC}:")
                    for idx, res in enumerate(data["v"][:5], 1): # Top 5
                        site = res.get("site_name") or "Сайт"
                        title = res.get("title") or "Без названия"
                        url = res.get("url") or ""
                        print(f"  📖 {idx}. {site}: \"{title}\" ({Colors.BLUE}{url}{Colors.ENDC})")
                    print()
                    if sse_callback:
                        sse_callback({"type": "search_results", "results": data["v"]})
                
                if "v" in data:
                    v_val = data["v"]
                    if isinstance(v_val, dict):
                        resp_id = v_val.get("response", {}).get("message_id")
                        if resp_id:
                            new_parent_id = resp_id
                        continue
                    
                    if isinstance(v_val, str):
                        # Classical quick-mode stream OR final response path
                        if active_path == "response/content":
                            if not first_text_printed:
                                print(f"{Colors.GREEN}{Colors.BOLD}DeepSeek:{Colors.ENDC} ", end="", flush=True)
                                first_text_printed = True
                            print(v_val, end="", flush=True)
                            full_response += v_val
                            if sse_callback:
                                sse_callback({"type": "response", "content": v_val})
                        # Expert-mode stream
                        elif active_path == "response/fragments/-1/content":
                            # Only print if this fragment is RESPONSE (THINK is silenced)
                            if current_frag_type == "RESPONSE":
                                if not first_text_printed:
                                    print(f"{Colors.GREEN}{Colors.BOLD}DeepSeek:{Colors.ENDC} ", end="", flush=True)
                                    first_text_printed = True
                                print(v_val, end="", flush=True)
                                full_response += v_val
                                if sse_callback:
                                    sse_callback({"type": "response", "content": v_val})
                            elif current_frag_type == "THINK":
                                if sse_callback:
                                    sse_callback({"type": "think", "content": v_val})
            else:
                try:
                    err_data = json.loads(line_str)
                    if "code" in err_data and err_data["code"] != 0:
                        err_msg = err_data.get('msg') or ""
                        print(f"\n{Colors.FAIL}[Ошибка DeepSeek {err_data.get('code')}]{Colors.ENDC} {err_msg}")
                        if "server is busy" in err_msg.lower() or "server_busy" in err_msg.lower() or "busy" in err_msg.lower():
                            print(f"\n{Colors.WARNING}[Сервер занят]{Colors.ENDC} Ожидание 5 секунд перед автоматической отправкой \"продолжай\"...")
                            time.sleep(5)
                            return "server_busy"
                        return None
                except json.JSONDecodeError:
                    pass
                        
        print("\n")
        return (new_parent_id or parent_message_id, full_response)
        
    except requests.exceptions.RequestException as e:
        print(f"\n{Colors.FAIL}[Ошибка сети]{Colors.ENDC} Не удалось выполнить запрос: {e}")
        return None

def send_chat_completion_with_retry(config, prompt, parent_message_id, search_enabled=False, model_type="default", sse_callback=None):
    while True:
        res_data = send_chat_completion(config, prompt, parent_message_id, search_enabled, model_type, sse_callback)
        if res_data == "server_busy":
            print(f"{Colors.BLUE}[Повторный запрос]{Colors.ENDC} Отправка \"продолжай\"...")
            prompt = "продолжай"
            search_enabled = False
            model_type = "default"
            continue
        return res_data


import atexit

def cleanup_resources():
    print(f"\n{Colors.BLUE}[Завершение работы] Завершаем фоновые процессы...{Colors.ENDC}")
    for proc in BACKGROUND_PROCESSES:
        try:
            proc.terminate()
            proc.wait(timeout=1)
        except Exception:
            pass

atexit.register(cleanup_resources)

def main():
    global GLOBAL_PARENT_MESSAGE_ID
    print_header("DeepSeek Companion Client")
    
    config = load_config()
    chat_session_id = config.get("chat_session_id")
    
    parent_message_id = None
    is_auth = False
    
    if chat_session_id:
        print(f"{Colors.DARK_GRAY}Синхронизация существующей сессии...{Colors.ENDC}", flush=True)
        parent_message_id, is_auth = get_last_message_id(config)
        
    if not chat_session_id or not is_auth:
        if not chat_session_id:
            print(f"{Colors.CYAN}[Инфо] Сессия чата отсутствует в конфигурации. Запуск Chrome для инициализации...{Colors.ENDC}", flush=True)
        else:
            print(f"{Colors.WARNING}[Не авторизован] Сессия недействительна или авторизация истекла. Запуск Chrome...{Colors.ENDC}", flush=True)
            
        import auth_fetcher
        success = auth_fetcher.fetch_tokens_and_save()
        if not success:
            print(f"{Colors.WARNING}[Предупреждение] Не удалось обновить сессию. Используем существующую конфигурацию...{Colors.ENDC}", flush=True)
        else:
            config = load_config()
            parent_message_id, is_auth = get_last_message_id(config)
            
    print(f"{Colors.GREEN}Сессия синхронизирована. ID последнего сообщения: {parent_message_id}{Colors.ENDC}\n", flush=True)
    GLOBAL_PARENT_MESSAGE_ID = parent_message_id
    
    args_to_parse = []
    
    if len(sys.argv) > 1:
        if sys.argv[1] in ('--cli', '-c'):
            args_to_parse = sys.argv[2:]
        else:
            args_to_parse = sys.argv[1:]
 
    print(f"{Colors.CYAN}{Colors.BOLD}Вы (авто-инициализация):{Colors.ENDC}\n[Отправка системного промпта...]\n")
    res_data = send_chat_completion_with_retry(config, SYSTEM_INIT_PROMPT, GLOBAL_PARENT_MESSAGE_ID)
    auto_prompt = None
    if res_data:
        next_id, full_response = res_data
        if next_id:
            GLOBAL_PARENT_MESSAGE_ID = next_id
            
        command = extract_terminal_command(full_response)
        if command:
            auto_prompt = execute_terminal_command(command)
    
    if args_to_parse:
        raw_prompt = " ".join(args_to_parse)
        prompt, search_enabled, model_type = parse_prompt_options(raw_prompt)
        
        mode_str = []
        if search_enabled:
            mode_str.append("поиск в сети")
        if model_type == "expert":
            mode_str.append("эксперт-режим")
        if mode_str:
            print(f"{Colors.CYAN}{Colors.BOLD}[Режим: {', '.join(mode_str)}]{Colors.ENDC}")
            
        print(f"{Colors.CYAN}{Colors.BOLD}Вы (аргумент):{Colors.ENDC} {prompt}")
        
        if auto_prompt:
            res_data = send_chat_completion_with_retry(config, auto_prompt, GLOBAL_PARENT_MESSAGE_ID)
            if res_data:
                next_id, full_response = res_data
                if next_id:
                    GLOBAL_PARENT_MESSAGE_ID = next_id
                    
        res_data = send_chat_completion_with_retry(config, prompt, GLOBAL_PARENT_MESSAGE_ID, search_enabled, model_type)
        if res_data:
            next_id, full_response = res_data
            GLOBAL_PARENT_MESSAGE_ID = next_id
            command = extract_terminal_command(full_response)
            if command:
                execute_terminal_command(command)
    else:
        print(f"{Colors.BLUE}Интерактивный режим чата. Введите 'exit' или 'quit' для выхода.{Colors.ENDC}")
        print(f"{Colors.DARK_GRAY}Используется сессия: {config.get('chat_session_id')}{Colors.ENDC}\n")
        
        while True:
            try:
                if auto_prompt:
                    prompt = auto_prompt
                    auto_prompt = None
                    search_enabled = False
                    model_type = "default"
                else:
                    raw_input = input(f"{Colors.CYAN}{Colors.BOLD}Вы >{Colors.ENDC} ")
                    if not raw_input.strip():
                        continue
                    if raw_input.strip().lower() in ['exit', 'quit']:
                        print(f"\n{Colors.BLUE}Выход из чата. До свидания!{Colors.ENDC}")
                        break
                    
                    prompt, search_enabled, model_type = parse_prompt_options(raw_input)
                    
                    mode_str = []
                    if search_enabled:
                        mode_str.append("поиск в сети")
                    if model_type == "expert":
                        mode_str.append("эксперт-режим")
                    if mode_str:
                        print(f"{Colors.CYAN}{Colors.BOLD}[Режим: {', '.join(mode_str)}]{Colors.ENDC}")
                    
                res_data = send_chat_completion_with_retry(config, prompt, GLOBAL_PARENT_MESSAGE_ID, search_enabled, model_type)
                if not res_data:
                    continue
                    
                next_id, full_response = res_data
                if next_id:
                    GLOBAL_PARENT_MESSAGE_ID = next_id
                
                command = extract_terminal_command(full_response)
                if command:
                    auto_prompt = execute_terminal_command(command)
                    
            except KeyboardInterrupt:
                print(f"\n{Colors.WARNING}Сессия прервана пользователем.{Colors.ENDC}")
                break
            except Exception as e:
                print(f"\n{Colors.FAIL}[Системная ошибка]{Colors.ENDC} {e}")
                break

if __name__ == '__main__':
    main()
