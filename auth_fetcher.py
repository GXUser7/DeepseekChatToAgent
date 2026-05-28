import os
import sys
import json
import time
import re
import shutil
import subprocess
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

class Colors:
    BLUE = '\033[94m'
    GREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    DARK_GRAY = '\033[90m'
    CYAN = '\033[96m'

def get_base_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        return os.path.dirname(os.path.abspath(__file__))

def find_chrome_path():
    if sys.platform.startswith('darwin'):
        paths = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
    elif sys.platform.startswith('win'):
        paths = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        ]
    else:
        paths = [
            "/usr/bin/google-chrome",
            "/usr/bin/chrome",
        ]
    for p in paths:
        if os.path.exists(p):
            return p
    return "chrome.exe" if sys.platform.startswith('win') else "google-chrome"

def copy_chrome_session():
    if sys.platform.startswith('win'):
        src_user_data = os.path.join(os.environ.get('USERPROFILE', ''), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
    elif sys.platform.startswith('darwin'):
        src_user_data = os.path.expanduser('~/Library/Application Support/Google/Chrome')
    else:
        src_user_data = os.path.expanduser('~/.config/google-chrome')
        
    src_profile = os.path.join(src_user_data, "Profile 6")
    
    base_dir = get_base_dir()
    dst_user_data = os.path.join(base_dir, "selenium_profile")
    dst_profile = os.path.join(dst_user_data, "Profile 6")
    
    if not os.path.exists(src_profile):
        print(f"{Colors.WARNING}[Предупреждение] Профиль Profile 6 не найден в системе.{Colors.ENDC}")
        return False
        
    print(f"{Colors.DARK_GRAY}[Auth] Копирование сессии из Profile 6 для обхода капчи...{Colors.ENDC}")
    os.makedirs(dst_profile, exist_ok=True)
    
    items_to_copy = [
        ("Network/Cookies", "Network/Cookies"),
        ("Cookies", "Cookies"),
        ("Local Storage", "Local Storage"),
    ]
    
    copied_any = False
    for rel_src, rel_dst in items_to_copy:
        src_path = os.path.join(src_profile, rel_src.replace('/', os.sep))
        dst_path = os.path.join(dst_profile, rel_dst.replace('/', os.sep))
        
        if os.path.exists(src_path):
            try:
                os.makedirs(os.path.dirname(dst_path), exist_ok=True)
                if os.path.isdir(src_path):
                    if os.path.exists(dst_path):
                        shutil.rmtree(dst_path)
                    shutil.copytree(src_path, dst_path, ignore=shutil.ignore_patterns('Cache*', '*temp*'))
                else:
                    shutil.copy2(src_path, dst_path)
                copied_any = True
            except Exception as e:
                # Sometimes files can be locked, but Windows usually allows reading
                pass
                
    if copied_any:
        print(f"{Colors.GREEN}[Stealth] Сессия успешно скопирована!{Colors.ENDC}")
    return copied_any

def try_launch_stealth_browser():
    base_dir = get_base_dir()
    chrome_path = find_chrome_path()
    
    # Copy session first so the user is pre-authenticated!
    copy_chrome_session()
    
    # Use our isolated selenium_profile folder to completely avoid Chrome locks!
    profile_dir = os.path.join(base_dir, "selenium_profile")
    profile_name = "Profile 6"
    
    print(f"{Colors.DARK_GRAY}[Auth] Запуск изолированного Chrome (порт 9222)...{Colors.ENDC}")
    
    chrome_cmd = [
        chrome_path,
        "--remote-debugging-port=9222",
        f"--user-data-dir={profile_dir}",
        f"--profile-directory={profile_name}",
        "--start-maximized",
        "--log-level=3",
        "https://chat.deepseek.com/"
    ]
    
    try:
        # Start Chrome process
        subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(3) # Wait for Chrome to bind port 9222
        
        # Connect Selenium via debugging port
        chrome_options = Options()
        chrome_options.add_experimental_option("debuggerAddress", "127.0.0.1:9222")
        driver = webdriver.Chrome(options=chrome_options)
        return driver
    except Exception as e:
        print(f"{Colors.FAIL}[Ошибка] Не удалось запустить Chrome или подключить отладчик: {e}{Colors.ENDC}")
        print(f"{Colors.WARNING}[Резерв] Запуск чистого стандартного Selenium браузера...{Colors.ENDC}")
        fallback_options = Options()
        fallback_options.add_argument("--start-maximized")
        try:
            return webdriver.Chrome(options=fallback_options)
        except Exception as fallback_err:
            raise fallback_err

def fetch_tokens_and_save():
    print(f"\n{Colors.BLUE}{Colors.BOLD}============================================================{Colors.ENDC}")
    print(f"{Colors.BLUE}{Colors.BOLD}          Автоматический вход и получение токенов          {Colors.ENDC}")
    print(f"{Colors.BLUE}{Colors.BOLD}============================================================{Colors.ENDC}\n")
    
    try:
        driver = try_launch_stealth_browser()
    except Exception as e:
        print(f"{Colors.FAIL}[Ошибка] Не удалось запустить Chrome: {e}{Colors.ENDC}")
        return False
        
    try:
        print(f"\n{Colors.GREEN}{Colors.BOLD}[ИНСТРУКЦИЯ]{Colors.ENDC}")
        print("1. В открывшемся окне Chrome выберите любой чат или создайте новый.")
        print("   👉 Чтобы использовать режим Эксперта или Поиск в сети:")
        print("      - Включите переключатели «DeepThink (R1)» и/или «Поиск в сети» внизу.")
        print("      - Напишите первое сообщение (например, «начать» или вашу команду) и отправьте.")
        print("   (Профиль скопирован, поэтому вы должны быть автоматически авторизованы!)")
        print("2. Как только откроется страница активного чата, программа перехватит токены и продолжит в консоли.\n")
        
        session_id = None
        user_token = None
        
        while True:
            # Check current URL for session ID
            try:
                current_url = driver.current_url
                match = re.search(r'chat/s/([a-f0-9\-]+)', current_url)
                if match:
                    session_id = match.group(1)
            except Exception:
                # If window was closed by user
                print(f"{Colors.WARNING}Браузер закрыт пользователем.{Colors.ENDC}")
                return False
                
            # Try to fetch userToken from localStorage
            try:
                user_token_raw = driver.execute_script("return localStorage.getItem('userToken');")
                if user_token_raw:
                    # Clean and parse the token
                    if user_token_raw.startswith('{'):
                        try:
                            token_json = json.loads(user_token_raw)
                            user_token = token_json.get("value") or token_json.get("token") or user_token_raw
                        except Exception:
                            user_token = user_token_raw
                    else:
                        user_token = user_token_raw
            except Exception:
                pass
                
            # If both session ID and token are found, we are ready!
            if session_id and user_token:
                # Ensure Authorization header starts with Bearer
                auth_header = user_token
                if not auth_header.startswith("Bearer "):
                    auth_header = f"Bearer {auth_header}"
                    
                # Format cookies
                cookies = driver.get_cookies()
                cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
                
                print(f"{Colors.GREEN}[Успешно] Данные авторизации получены!{Colors.ENDC}")
                print(f"{Colors.DARK_GRAY}Session ID: {session_id}{Colors.ENDC}")
                
                # Save to config.json
                config_data = {
                    "chat_session_id": session_id,
                    "authorization": auth_header,
                    "cookie": cookie_str
                }
                
                config_path = os.path.join(get_base_dir(), "config.json")
                with open(config_path, "w", encoding="utf-8") as f:
                    json.dump(config_data, f, indent=4, ensure_ascii=False)
                    
                print(f"{Colors.GREEN}[Успешно] Конфигурация config.json обновлена.{Colors.ENDC}\n")
                
                # Small pause and close browser
                time.sleep(2)
                try:
                    driver.quit()
                except Exception:
                    pass
                return True
                
            time.sleep(1.5)
            
    except KeyboardInterrupt:
        print(f"\n{Colors.WARNING}Прервано пользователем. Закрытие браузера...{Colors.ENDC}")
        try:
            driver.quit()
        except Exception:
            pass
        return False
    except Exception as e:
        print(f"\n{Colors.FAIL}[Ошибка в процессе работы]: {e}{Colors.ENDC}")
        try:
            driver.quit()
        except Exception:
            pass
        return False

if __name__ == "__main__":
    fetch_tokens_and_save()
