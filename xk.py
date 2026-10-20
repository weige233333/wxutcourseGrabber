#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
无锡职业技术学院 教务系统（zhjw.wxut.edu.cn/jsxsd）公选课选课辅助脚本

用法（在本文件所在目录打开 PowerShell）：
    python xk.py login                  # 登录并保存会话（密码只输入，不落盘）
    python xk.py list                   # 列出当前可选课程，生成 work/dump/courses.csv
    python xk.py grab                   # 按 config.json 里的目标课程循环选课
    python xk.py grab --dry-run         # 只演练，不真正提交选课请求
    python xk.py dump                   # 抓取选课页面原始 HTML，排错用

会话保存在 .xk_runtime/cookies.json；日志在 .xk_runtime/xk.log。
"""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import json
import os
import random
import re
import sys
import time
from html.parser import HTMLParser
from pathlib import Path

import requests

BASE = "https://zhjw.wxut.edu.cn"
LOGIN_URL = BASE + "/jsxsd/xk/LoginToXk"
HOME_URL = BASE + "/jsxsd/framework/xsMainV_wxzyjsxy.htmlx"
COME_IN_URL = BASE + "/jsxsd/xsxkkc/comeIn"

HERE = Path(__file__).resolve().parent
RUNTIME = HERE / ".xk_runtime"
DUMP = RUNTIME / "dump"
COOKIE_FILE = RUNTIME / "cookies.json"
LOG_FILE = RUNTIME / "xk.log"
CONFIG_FILE = HERE / "config.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

SUCCESS_WORDS = ("选课成功", "操作成功", "成功选课", '"success":true', '"success": true')
ALREADY_WORDS = ("已选", "重复选课", "已经选过")
FULL_WORDS = ("人数已满", "已满", "容量不足", "名额已满", "余量为0", "余量为 0")
CONFLICT_WORDS = ("冲突", "时间不冲突", "上课时间冲突")
NOT_OPEN_WORDS = ("未开放", "不在选课时间", "选课时间未", "尚未开始", "已结束")


def log(msg: str) -> None:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    line = f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    with LOG_FILE.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


# ---------------------------------------------------------------- HTML 解析


class TableParser(HTMLParser):
    """把页面里的所有 <table> 拆成单元格列表，同时保留每行里的链接和表单。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[dict]] = []
        self._stack: list[list[dict]] = []
        self._row: dict | None = None
        self._cell: dict | None = None
        self._link: dict | None = None
        self._in_script = False
        self.scripts: list[str] = []
        self._script_buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script":
            self._in_script = True
            self._script_buf = []
        elif tag == "table":
            self._stack.append([])
        elif tag == "tr" and self._stack:
            self._row = {"cells": [], "links": [], "inputs": []}
        elif tag in ("td", "th") and self._row is not None:
            self._cell = {"text": "", "links": []}
        elif tag == "a" and self._row is not None:
            self._link = {
                "text": "",
                "href": attrs.get("href", ""),
                "onclick": attrs.get("onclick", ""),
                "title": attrs.get("title", ""),
            }
        elif tag in ("input", "button") and self._row is not None:
            self._row["inputs"].append(
                {
                    "tag": tag,
                    "type": attrs.get("type", ""),
                    "name": attrs.get("name", ""),
                    "value": attrs.get("value", ""),
                    "onclick": attrs.get("onclick", ""),
                    "text": attrs.get("value", ""),
                }
            )

    def handle_endtag(self, tag):
        if tag == "script":
            self._in_script = False
            self.scripts.append("".join(self._script_buf))
        elif tag == "table" and self._stack:
            self.tables.append(self._stack.pop())
        elif tag == "tr" and self._row is not None:
            if self._stack:
                self._stack[-1].append(self._row)
            self._row = None
            self._cell = None
        elif tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._cell["text"] = clean(self._cell["text"])
            self._row["cells"].append(self._cell)
            self._cell = None
        elif tag == "a" and self._link is not None:
            self._link["text"] = clean(self._link["text"])
            if self._cell is not None:
                self._cell["links"].append(self._link)
            if self._row is not None:
                self._row["links"].append(self._link)
            self._link = None

    def handle_data(self, data):
        if self._in_script:
            self._script_buf.append(data)
            return
        if self._link is not None:
            self._link["text"] += data
        elif self._cell is not None:
            self._cell["text"] += data


def parse_tables(html: str) -> tuple[list[list[dict]], list[str]]:
    p = TableParser()
    p.feed(html)
    return p.tables, p.scripts


HEADER_KEYS = {
    "name": ("课程名称", "课程名", "课程"),
    "teacher": ("教师", "老师", "任课"),
    "time": ("上课时间", "时间", "节次"),
    "place": ("上课地点", "地点", "教室"),
    "capacity": ("容量", "人数上限", "上限"),
    "selected": ("已选", "选课人数"),
    "remaining": ("余量", "剩余", "可选"),
    "code": ("课程号", "课程代码", "课程编号"),
}


def header_map(cells: list[str]) -> dict[str, int] | None:
    mapping: dict[str, int] = {}
    for idx, text in enumerate(cells):
        for key, words in HEADER_KEYS.items():
            if key in mapping:
                continue
            if any(w in text for w in words):
                mapping[key] = idx
    return mapping if "name" in mapping else None


def to_int(text: str) -> int | None:
    m = re.search(r"-?\d+", text or "")
    return int(m.group()) if m else None


def extract_courses(tables: list[list[dict]]) -> list[dict]:
    courses: list[dict] = []
    for table in tables:
        mapping = None
        for row in table:
            texts = [c["text"] for c in row["cells"]]
            if mapping is None:
                mapping = header_map(texts)
                continue
            if not any(texts):
                continue
            def cell(key):
                idx = mapping.get(key)
                return texts[idx] if idx is not None and idx < len(texts) else ""

            name = cell("name")
            if not name or name in ("课程名称", "合计", "总计"):
                continue
            course = {
                "name": name,
                "code": cell("code"),
                "teacher": re.sub(r"\[.*?\]|（.*?）", "", cell("teacher")).strip(),
                "time": cell("time"),
                "place": cell("place"),
                "capacity": to_int(cell("capacity")),
                "selected": to_int(cell("selected")),
                "remaining": to_int(cell("remaining")),
                "cells": texts,
                "links": row["links"],
                "inputs": row["inputs"],
            }
            if course["remaining"] is None and course["capacity"] is not None and course["selected"] is not None:
                course["remaining"] = course["capacity"] - course["selected"]
            courses.append(course)
    return courses


# ---------------------------------------------------------------- 会话


class AuthError(RuntimeError):
    pass


class XkClient:
    def __init__(self) -> None:
        self.s = requests.Session()
        self.s.headers.update(
            {
                "User-Agent": UA,
                "Accept-Language": "zh-CN,zh;q=0.9",
            }
        )
        self.page_url = COME_IN_URL
        self.pages: list[tuple[str, str]] = []
        self.scripts: list[str] = []

    # -- cookie 持久化
    def save_cookies(self) -> None:
        RUNTIME.mkdir(parents=True, exist_ok=True)
        COOKIE_FILE.write_text(
            json.dumps(requests.utils.dict_from_cookiejar(self.s.cookies), ensure_ascii=False),
            encoding="utf-8",
        )

    def load_cookies(self) -> bool:
        if not COOKIE_FILE.exists():
            return False
        try:
            data = json.loads(COOKIE_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return False
        self.s.cookies.update(data)
        return True

    def import_cookie_string(self, raw: str) -> None:
        for part in raw.split(";"):
            if "=" not in part:
                continue
            k, v = part.split("=", 1)
            self.s.cookies.set(k.strip(), v.strip(), domain="zhjw.wxut.edu.cn", path="/")
        self.save_cookies()

    # -- 登录
    def login(self, user: str, password: str) -> None:
        self.s.get(BASE + "/jsxsd/", timeout=20)
        payload = {
            "userAccount": user,
            "userPassword": "",
            "encoded": b64(user) + "%%%" + b64(password),
        }
        r = self.s.post(
            LOGIN_URL,
            data=payload,
            timeout=20,
            headers={"Referer": BASE + "/jsxsd/"},
        )
        r.encoding = "utf-8"
        if "该账号不存在或密码错误" in r.text:
            raise AuthError("账号或密码错误（教务系统密码，不是门户密码的话请用 --cookie 方式复用浏览器会话）")
        if 'id="loginForm"' in r.text and "选课" not in r.text:
            m = re.search(r'id="showMsg"[^>]*>(.*?)</font>', r.text, re.S)
            raise AuthError("登录失败：" + (clean(m.group(1)) if m else "页面仍停留在登录页，可能需要验证码"))
        if not self.check_login():
            raise AuthError("登录后仍无法进入教务系统主页，可能需要验证码或账号被限制")
        self.save_cookies()
        log(f"登录成功：{user}")

    def check_login(self) -> bool:
        try:
            r = self.s.get(HOME_URL, timeout=20)
        except requests.RequestException:
            return False
        r.encoding = "utf-8"
        return 'id="loginForm"' not in r.text and ("退出" in r.text or "xsMain" in r.text or len(r.text) > 5000)

    def ensure_login(self, user: str | None, password: str | None) -> None:
        if self.load_cookies() and self.check_login():
            log("复用已保存的登录会话")
            return
        if not user:
            user = input("学号（10位）：").strip()
        if not password:
            import getpass

            password = getpass.getpass("教务系统密码（输入不回显）：")
        self.login(user, password)

    # -- 选课页面发现
    def refresh_pages(self, light: bool = False) -> None:
        """抓取选课中心，并顺便抓取其中 iframe / 链接指向的选课页。"""
        if light and getattr(self, "list_urls", None):
            self.pages = []
            for u in self.list_urls[:2]:
                try:
                    rr = self.s.get(u, timeout=20)
                    rr.encoding = "utf-8"
                except requests.RequestException:
                    continue
                if 'id="loginForm"' in rr.text:
                    raise AuthError("会话已失效，请重新 login")
                self.pages.append((rr.url, rr.text))
            if self.pages:
                self.page_url = self.pages[0][0]
                return

        r = self.s.get(COME_IN_URL, timeout=20)
        r.encoding = "utf-8"
        if 'id="loginForm"' in r.text:
            raise AuthError("会话已失效，请重新 login")
        html = r.text
        self.page_url = r.url
        self.pages = [(r.url, html)]
        self.scripts = []
        _, scripts = parse_tables(html)
        self.scripts = scripts

        urls = set()
        for m in re.finditer(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', html):
            u = m.group(1)
            if "xsxkkc" in u or "xsxk" in u:
                urls.add(requests.compat.urljoin(r.url, u))
        for cand in ("/jsxsd/xsxkkc/xsxkGgxx",):
            urls.add(BASE + cand)

        for u in list(urls)[:6]:
            try:
                rr = self.s.get(u, timeout=20)
                rr.encoding = "utf-8"
            except requests.RequestException as exc:
                log(f"  ! 打开 {u} 失败：{exc}")
                continue
            if 'id="loginForm"' in rr.text:
                raise AuthError("会话已失效，请重新 login")
            self.pages.append((rr.url, rr.text))
            _, more = parse_tables(rr.text)
            self.scripts.extend(more)

        # 选课动作有时写在外部 js 里，抓取同源脚本便于定位提交地址
        srcs = set()
        for _, html_text in self.pages:
            for m in re.finditer(r'<script[^>]+src\s*=\s*["\']([^"\']+)["\']', html_text, re.I):
                src = requests.compat.urljoin(self.page_url, m.group(1))
                if src.startswith(BASE):
                    srcs.add(src)
        for src in list(srcs)[:8]:
            try:
                rr = self.s.get(src, timeout=15)
            except requests.RequestException:
                continue
            if rr.status_code == 200 and "text" in rr.headers.get("Content-Type", ""):
                self.scripts.append(rr.text)

        # 脚本里出现的选课接口路径，也各取一次看看是不是列表页
        endpoints = []
        for s in self.scripts:
            for m in re.finditer(r'["\'](/jsxsd/xsxkkc/[A-Za-z0-9_]+)["\']', s):
                path = m.group(1)
                if path.rstrip("/").endswith("comeIn") or path in endpoints:
                    continue
                endpoints.append(path)
        existing = {u for u, _ in self.pages}
        for path in endpoints[:4]:
            u = BASE + path
            if u in existing:
                continue
            try:
                rr = self.s.get(u, timeout=15)
                rr.encoding = "utf-8"
            except requests.RequestException:
                continue
            if rr.status_code == 200 and 'id="loginForm"' not in rr.text:
                self.pages.append((rr.url, rr.text))

        # 以包含最多课程行的页面作为“选课页”，供相对地址和 Referer 使用
        best = max(self.pages, key=lambda p: len(extract_courses(parse_tables(p[1])[0])))
        self.page_url = best[0]
        self.list_urls = [u for u, h in self.pages if extract_courses(parse_tables(h)[0])]

    def all_html(self) -> str:
        return "\n".join(html for _, html in self.pages)

    def dump(self, tag: str = "page") -> Path:
        DUMP.mkdir(parents=True, exist_ok=True)
        path = DUMP / f"{tag}_{dt.datetime.now():%H%M%S}.html"
        path.write_text(self.all_html(), encoding="utf-8")
        return path

    # -- 选课动作
    def _function_body(self, fname: str) -> str:
        blob = "\n".join(self.scripts) + "\n" + self.all_html()
        m = re.search(
            r"function\s+" + re.escape(fname) + r"\s*\(([^)]*)\)\s*\{(.*?)\n\s*\}",
            blob,
            re.S,
        )
        return m.group(2) if m else ""

    def _post_candidates(self, course: dict) -> list[tuple[str, dict]]:
        out: list[tuple[str, dict]] = []
        ids: list[str] = []
        fname = None
        onclick_text = ""
        for link in course["links"] + course["inputs"]:
            if "选课" not in (link.get("text") or "") and "选课" not in (link.get("onclick") or ""):
                continue
            onclick_text = link.get("onclick") or ""
            href = link.get("href") or ""
            if href and not href.lower().startswith("javascript"):
                out.append((requests.compat.urljoin(self.page_url, href), {}))
            m = re.match(r"\s*([A-Za-z_$][\w$]*)\s*\((.*)\)", onclick_text)
            if m:
                fname = m.group(1)
                ids = re.findall(r"['\"]([^'\"]+)['\"]", m.group(2))

        body = self._function_body(fname) if fname else ""
        url = None
        keys: list[str] = []
        if body:
            m = re.search(r"(?:url|action)\s*[:=]\s*['\"]([^'\"]+)['\"]", body)
            if m:
                url = requests.compat.urljoin(self.page_url, m.group(1))
            km = re.search(r"data\s*:\s*\{(.*?)\}", body, re.S)
            if km:
                keys = re.findall(r"(\w+)\s*:", km.group(1))

        if not url and fname:
            guesses = {
                "xk": "/jsxsd/xsxkkc/xsxkGgxx",
                "xsxk": "/jsxsd/xsxkkc/xsxkGgxx",
                "xkg": "/jsxsd/xsxkkc/xsxkGgxx",
            }
            url = BASE + guesses.get(fname.lower(), "/jsxsd/xsxkkc/xsxkGgxx")
        url = url or BASE + "/jsxsd/xsxkkc/xsxkGgxx"

        if keys and len(keys) >= len(ids):
            out.append((url, dict(zip(keys, ids))))
        if len(ids) >= 2:
            a, b = ids[0], ids[1]
            out.extend(
                [
                    (url, {"kcId": a, "jxId": b}),
                    (url, {"kch_id": a, "jxb_id": b}),
                    (url, {"kcid": a, "jxid": b}),
                    (url, {"kcId": b, "jxId": a}),
                ]
            )
            out.append((url + f"?kcId={requests.utils.quote(a)}&jxId={requests.utils.quote(b)}", {}))
        return out

    def attempt(self, course: dict, dry_run: bool = False) -> str:
        cands = self._post_candidates(course)
        if not cands:
            return "no-action"
        if dry_run:
            log(f"  [演练] 将尝试 {course['name']}，候选请求 {len(cands)} 个，首个：{cands[0][0]} {cands[0][1]}")
            return "dry-run"
        for url, data in cands:
            try:
                r = self.s.post(
                    url,
                    data=data,
                    timeout=20,
                    headers={"Referer": self.page_url, "X-Requested-With": "XMLHttpRequest"},
                )
            except requests.RequestException as exc:
                log(f"  ! 请求异常：{exc}")
                time.sleep(1)
                continue
            r.encoding = "utf-8"
            text = r.text
            low = text.replace(" ", "").lower()
            if 'id="loginForm"' in text:
                raise AuthError("会话失效")
            if any(w in text for w in SUCCESS_WORDS) or '"success":true' in low:
                return "success"
            if any(w in text for w in ALREADY_WORDS):
                return "already"
            if any(w in text for w in FULL_WORDS):
                return "full"
            if any(w in text for w in CONFLICT_WORDS) and "不冲突" not in text:
                return "conflict"
            if any(w in text for w in NOT_OPEN_WORDS):
                return "closed"
            self._last_error = clean(re.sub(r"<[^>]+>", " ", text))[:200]
        return "unknown"


# ---------------------------------------------------------------- 配置


DEFAULT_CONFIG = {
    "_说明": "targets 按优先级从上到下；name 必填，teacher/time 可选用于区分同名课程；最多选 max_courses 门",
    "max_courses": 2,
    "interval_seconds": 3,
    "jitter_seconds": 1.0,
    "refresh_seconds": 15,
    "deadline": "2026-10-23 13:30",
    "targets": [
        {"name": "AIGC应用", "teacher": "史荧中"},
        {"name": "Python数据分析", "teacher": "邱晓荣"},
    ],
}


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        CONFIG_FILE.write_text(json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"已生成配置文件：{CONFIG_FILE}")
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    cfg.setdefault("max_courses", 2)
    cfg.setdefault("interval_seconds", 3)
    cfg.setdefault("jitter_seconds", 1.0)
    cfg.setdefault("refresh_seconds", 15)
    cfg.setdefault("targets", [])
    return cfg


def match(course: dict, target: dict) -> bool:
    if target.get("name") and target["name"] not in course["name"]:
        return False
    if target.get("teacher") and target["teacher"] not in course["teacher"]:
        return False
    if target.get("time") and target["time"].replace(" ", "") not in course["time"].replace(" ", ""):
        return False
    return True


def print_courses(courses: list[dict]) -> None:
    if not courses:
        print("没有解析到课程，可能页面结构特殊，请运行 `python xk.py dump` 后查看 .xk_runtime/dump/")
        return
    print(f"{'课程名称':<30}{'教师':<8}{'上课时间':<28}{'地点':<18}{'余量':>5}")
    print("-" * 92)
    for c in courses:
        rem = "" if c["remaining"] is None else str(c["remaining"])
        print(f"{c['name'][:28]:<30}{c['teacher'][:6]:<8}{c['time'][:26]:<28}{c['place'][:16]:<18}{rem:>5}")


def save_courses_csv(courses: list[dict]) -> Path:
    DUMP.mkdir(parents=True, exist_ok=True)
    path = DUMP / "courses.csv"
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["课程名称", "教师", "上课时间", "地点", "容量", "已选", "余量"])
        for c in courses:
            w.writerow([c["name"], c["teacher"], c["time"], c["place"], c["capacity"], c["selected"], c["remaining"]])
    return path


# ---------------------------------------------------------------- 命令


def cmd_login(args, client: XkClient) -> None:
    client.ensure_login(args.user, args.password)
    client.refresh_pages()
    courses = extract_courses(parse_tables(client.all_html())[0])
    log(f"选课页面可访问，解析到 {len(courses)} 门课程")


def cmd_list(args, client: XkClient) -> None:
    client.ensure_login(args.user, args.password)
    client.refresh_pages()
    courses = extract_courses(parse_tables(client.all_html())[0])
    print_courses(courses)
    if courses:
        log(f"已保存课程列表：{save_courses_csv(courses)}")
    client.dump("list")


def cmd_dump(args, client: XkClient) -> None:
    client.ensure_login(args.user, args.password)
    client.refresh_pages()
    path = client.dump("dump")
    DUMP.mkdir(parents=True, exist_ok=True)
    for i, s in enumerate(client.scripts):
        (DUMP / f"script_{i}.js").write_text(s, encoding="utf-8")
    log(f"已保存：{path}（以及 script_*.js）")


def cmd_grab(args, client: XkClient) -> None:
    cfg = load_config()
    targets = cfg["targets"]
    if not targets:
        log("config.json 里 targets 为空，先填目标课程")
        return
    client.ensure_login(args.user, args.password)

    deadline = None
    if cfg.get("deadline"):
        try:
            deadline = dt.datetime.strptime(cfg["deadline"], "%Y-%m-%d %H:%M")
        except ValueError:
            log(f"deadline 格式不正确：{cfg['deadline']}")

    done: list[str] = []
    attempts: dict[str, int] = {t["name"]: 0 for t in targets}
    courses: list[dict] = []
    last_refresh = 0.0
    max_courses = int(cfg["max_courses"])

    while len(done) < max_courses:
        if deadline and dt.datetime.now() > deadline:
            log("已到截止时间，停止")
            break
        if time.time() - last_refresh >= cfg["refresh_seconds"] or not courses:
            client.refresh_pages(light=True)
            courses = extract_courses(parse_tables(client.all_html())[0])
            if not courses:
                client.refresh_pages()
                courses = extract_courses(parse_tables(client.all_html())[0])
            last_refresh = time.time()
            if not courses:
                log("本轮没有解析到课程；稍后重试，如持续为空请运行 dump 检查页面")

        acted = False
        for target in targets:
            if len(done) >= max_courses:
                break
            matched = [c for c in courses if match(c, target)]
            matched = [c for c in matched if c["remaining"] is None or c["remaining"] > 0]
            if not matched:
                continue
            if attempts[target["name"]] >= args.max_attempts:
                continue
            course = matched[0]
            attempts[target["name"]] += 1
            log(f"尝试选课：{course['name']} / {course['teacher']} / {course['time']}（第 {attempts[target['name']]} 次）")
            result = client.attempt(course, dry_run=args.dry_run)
            acted = True
            if result in ("success", "already"):
                done.append(course["name"])
                log(f"[成功] {course['name']}（{result}）")
            elif result == "full":
                log("  × 名额已满")
            elif result == "conflict":
                log("  × 与已选课程冲突")
            elif result == "closed":
                log("  × 当前不可选（未开放/已结束）")
            elif result == "no-action":
                log("  ? 没找到“选课”按钮，请运行 dump 排查")
            else:
                log(f"  ? 结果未识别：{getattr(client, '_last_error', '')}")
            time.sleep(cfg["interval_seconds"] + random.uniform(0, cfg["jitter_seconds"]))

        if not acted:
            time.sleep(cfg["interval_seconds"])

    log("结束，已选：" + ("、".join(done) if done else "无"))


def main() -> None:
    ap = argparse.ArgumentParser(description="无锡职院公选课选课脚本")
    ap.add_argument("command", choices=["login", "list", "grab", "dump"])
    ap.add_argument("--user", help="学号")
    ap.add_argument("--password", help="教务系统密码（不建议写在命令行，默认交互输入）")
    ap.add_argument("--cookie", help='浏览器里复制的 Cookie，如 "bzb_jsxsd=xxx; SERVERID=yyy"')
    ap.add_argument("--dry-run", action="store_true", help="只演练不提交")
    ap.add_argument("--max-attempts", type=int, default=80, help="每门课最多尝试次数")
    args = ap.parse_args()

    client = XkClient()
    if args.cookie:
        client.import_cookie_string(args.cookie)
    try:
        {"login": cmd_login, "list": cmd_list, "grab": cmd_grab, "dump": cmd_dump}[args.command](args, client)
    except AuthError as exc:
        log(f"登录/会话问题：{exc}")
        sys.exit(2)
    except KeyboardInterrupt:
        log("手动停止")


if __name__ == "__main__":
    main()
