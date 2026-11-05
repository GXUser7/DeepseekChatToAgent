from html.parser import HTMLParser
from pathlib import Path
import re
import unittest

WEB = Path(__file__).resolve().parents[1] / 'web'


class Page(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.ids, self.references, self.inline_scripts = [], [], 0
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if 'id' in attributes:
            self.ids.append(attributes['id'])
        if tag == 'script' and 'src' not in attributes:
            self.inline_scripts += 1
        for name in ('href', 'src'):
            value = attributes.get(name)
            if value and tag in ('link', 'script') and value.startswith('/'):
                self.references.append(value)


class WebStaticTests(unittest.TestCase):
    def setUp(self):
        self.html = (WEB / 'index.html').read_text(encoding='utf-8')
        self.page = Page(self.html)
        self.scripts = {name: (WEB / name).read_text(encoding='utf-8') for name in ('app.js', 'git.js', 'theme.js')}

    def test_ids_are_unique_and_assets_exist(self):
        self.assertEqual(len(self.page.ids), len(set(self.page.ids)))
        for reference in self.page.references:
            with self.subTest(reference=reference):
                self.assertTrue((WEB / reference.lstrip('/')).is_file())
        self.assertTrue((WEB / 'favicon.svg').is_file())

    def test_no_inline_scripts_for_the_csp(self):
        # The server sends script-src 'self', so inline scripts would be blocked.
        self.assertEqual(self.page.inline_scripts, 0)
        self.assertNotRegex(self.html, r'\son[a-z]+=')

    def test_every_icon_used_exists_in_the_sprite(self):
        symbols = set(re.findall(r'<symbol id="i-([\w-]+)"', self.html))
        used = set(re.findall(r'#i-([\w-]+)', self.html))
        for source in self.scripts.values():
            for arguments in re.findall(r"icon\(([^()]*)\)", source):
                used.update(re.findall(r"'([\w-]+)'", arguments.split(',')[0] if '?' not in arguments else arguments))
        self.assertFalse(used - symbols, f'missing icons: {sorted(used - symbols)}')

    def test_element_ids_used_by_app_exist(self):
        for name in ('app.js',):
            for element_id in set(re.findall(r"\$\('#([\w-]+)'\)", self.scripts[name])):
                with self.subTest(element_id=element_id):
                    self.assertIn(element_id, self.page.ids)

    def test_no_network_resources(self):
        for source in (self.html, *self.scripts.values(), (WEB / 'styles.css').read_text(encoding='utf-8')):
            self.assertNotRegex(source, r'(src|href)=["\']https?://(?!chat\.deepseek\.com)')
            self.assertNotRegex(source, r'@import|url\(["\']?https?:')


if __name__ == '__main__':
    unittest.main()
