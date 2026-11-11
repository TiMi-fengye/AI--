#!/usr/bin/env python3
"""Run interactively on the application server; never pass passwords as arguments."""
import getpass
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request
import warnings


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    if not 0 < port < 65536:
        raise ValueError("端口无效")
    base = "http://127.0.0.1:" + str(port)
    client = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
    )
    with client.open(base + "/api/auth/status", timeout=10) as response:
        status = json.load(response)
    if status.get("ok") is not True or "setupRequired" not in status:
        raise RuntimeError("服务器尚未运行支持账号初始化的版本。")
    if not status.get("setupRequired"):
        print("管理员已经初始化，请在网页使用现有账号登录。")
        return
    if not status.get("setupAllowed"):
        raise RuntimeError("请在运行应用服务的服务器本机执行。")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = getpass.getpass("设置管理员密码（至少12位，输入时不显示）：")
            confirm = getpass.getpass("再次输入管理员密码：")
    except (getpass.GetPassWarning, EOFError):
        raise RuntimeError("无法安全隐藏密码输入，请在服务器的交互式终端执行。") from None
    if password != confirm:
        raise ValueError("两次密码不一致，未执行初始化。")
    if not 12 <= len(password) <= 256:
        raise ValueError("密码须为12至256位，未执行初始化。")
    request = urllib.request.Request(
        base + "/api/auth/setup",
        data=json.dumps({"password": password}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with client.open(request, timeout=15) as response:
        result = json.load(response)
    del password, confirm, request
    if not result.get("ok") or result.get("user", {}).get("role") != "admin":
        raise RuntimeError("管理员初始化未获确认。")
    print("管理员初始化成功，登录账号：admin。密码未写入命令历史或部署脚本。")
    with client.open(base + "/api/data/snapshot.json", timeout=15) as response:
        snapshot = json.load(response)
    print("管理员登录和资料读取验证通过，现有人员数量：", len(snapshot.get("employees", [])))


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        try:
            message = json.load(error).get("message", "接口拒绝了请求")
        except (ValueError, OSError):
            message = "接口拒绝了请求"
        print("初始化失败：", message, file=sys.stderr)
        sys.exit(1)
    except (ValueError, RuntimeError, OSError) as error:
        print("初始化失败：", str(error), file=sys.stderr)
        sys.exit(1)
