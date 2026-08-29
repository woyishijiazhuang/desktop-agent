#!/usr/bin/env python3
"""
一个限速的HTTP服务器，用于测试下载工具样式。
默认以每秒100KB的速度提供文件下载。
"""
import http.server
import socketserver
import time
import os
import sys

PORT = 8080
FILE_PATH = "testfile.bin"
CHUNK_SIZE = 1024  # 每次发送1KB
DELAY = 0.02      # 每块延迟0.02秒，相当于每秒50KB

class ThrottledHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # 只处理根路径的下载请求
        if self.path == '/' or self.path == '/download':
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Disposition', 'attachment; filename="testfile.bin"')
            file_size = os.path.getsize(FILE_PATH)
            self.send_header('Content-Length', str(file_size))
            self.end_headers()
            
            # 分块发送并限速
            with open(FILE_PATH, 'rb') as f:
                while True:
                    chunk = f.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    time.sleep(DELAY)
        else:
            self.send_error(404)

if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), ThrottledHandler) as httpd:
        print(f"限速下载服务器启动")
        print(f"下载地址: http://localhost:{PORT}/")
        print(f"文件大小: {os.path.getsize(FILE_PATH)} bytes")
        print(f"预计下载时间: {os.path.getsize(FILE_PATH) / (CHUNK_SIZE / DELAY):.1f} 秒")
        print("按 Ctrl+C 停止服务器")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务器已停止")