import http.server
import os

PORT = int(os.environ.get('PORT', 3000))
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    with http.server.ThreadingHTTPServer(('', PORT), NoCacheHandler) as httpd:
        print(f'Serving {ROOT} at http://localhost:{PORT} (caching disabled)')
        httpd.serve_forever()
