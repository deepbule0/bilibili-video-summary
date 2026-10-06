"""Reproducible local coding/general comparison; never switches app defaults.

Generated functions are AST-restricted, then tested in a time-limited child
process without import, file, network, shell, or reflection interfaces. This
is a guard for these small pure-function tasks, not a general security sandbox.
"""
from __future__ import annotations

import argparse
import ast
import copy
import csv
import io
import itertools
import json
import math
import os
from pathlib import Path
import random
import re
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
CASES_PATH = ROOT / "engine/evaluation/coding-general-cases.json"
API = "http://127.0.0.1:11434"
BUILTINS = {
    key: getattr(__import__("builtins"), key)
    for key in (
        "len", "range", "enumerate", "zip", "sorted", "reversed", "min", "max",
        "sum", "any", "all", "list", "dict", "set", "tuple", "str", "int",
        "float", "bool", "abs", "isinstance", "ValueError", "TypeError",
        "Exception", "next", "iter", "slice",
    )
}
METHODS = {
    "append", "extend", "sort", "copy", "items", "keys", "values", "pop",
    "remove", "clear", "index", "count", "get", "setdefault", "update",
    "discard", "add", "join", "split", "startswith", "endswith", "strip",
    "lower", "upper", "replace", "isalnum", "isdigit", "isspace", "reverse",
    "insert", "union", "intersection", "difference",
}


def check(name: str, passed: bool, detail: str = "") -> dict:
    return {"name": name, "passed": bool(passed), "detail": detail}


def code_namespace(content: str) -> dict:
    stripped = content.strip()
    match = re.fullmatch(r"```(?:python)?\s*\n(.*?)\n```", stripped, re.S)
    source = match.group(1) if match else stripped
    tree = ast.parse(source)
    if not tree.body or not all(isinstance(node, ast.FunctionDef) for node in tree.body):
        raise ValueError("Only function definitions are allowed at module level")
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.ClassDef, ast.Global,
                             ast.Nonlocal, ast.AsyncFunctionDef, ast.With, ast.AsyncWith)):
            raise ValueError(f"Disallowed syntax: {type(node).__name__}")
        if isinstance(node, ast.Name) and node.id.startswith("__"):
            raise ValueError("Reflection names are disallowed")
        if isinstance(node, ast.Attribute) and node.attr not in METHODS:
            raise ValueError(f"Disallowed attribute: {node.attr}")
        if isinstance(node, ast.FunctionDef) and (node.decorator_list or node.name.startswith("__")):
            raise ValueError("Decorators/reflection function names are disallowed")
    namespace = {"__builtins__": BUILTINS}
    exec(compile(tree, "<model-function>", "exec"), namespace)
    return namespace


def union_reference(intervals: list[list[int]]) -> list[list[int]]:
    # Independent transitive-union oracle, not the sorted one-pass implementation.
    pending = copy.deepcopy(intervals)
    changed = True
    while changed:
        changed = False
        for left in range(len(pending)):
            for right in range(left + 1, len(pending)):
                a, b = pending[left], pending[right]
                if max(a[0], b[0]) <= min(a[1], b[1]):
                    pending[left] = [min(a[0], b[0]), max(a[1], b[1])]
                    pending.pop(right)
                    changed = True
                    break
            if changed:
                break
    return sorted(pending)


def order_reference(deps: dict[str, list[str]]) -> list[str]:
    if any(item not in deps for values in deps.values() for item in values):
        raise ValueError("missing prerequisite")
    result = []
    while len(result) < len(deps):
        ready = sorted(key for key, values in deps.items()
                       if key not in result and all(item in result for item in values))
        if not ready:
            raise ValueError("cycle")
        result.append(ready[0])
    return result


def coding_checks(case: dict, content: str) -> list[dict]:
    namespace = code_namespace(content)
    func = namespace.get(case["entrypoint"])
    if not callable(func):
        return [check("entrypoint", False, "Requested function not found")]
    checks = []

    def expect(name, argument, expected=None, raises=False):
        argument = copy.deepcopy(argument)
        original = copy.deepcopy(argument)
        try:
            result = func(argument)
            passed = not raises and result == expected
            detail = "" if passed else f"Expected {expected!r}; got {result!r}"
        except Exception as error:
            passed = raises and isinstance(error, ValueError)
            detail = "" if passed else f"{type(error).__name__}: {error}"
        unchanged = argument == original
        checks.append(check(name, passed and unchanged,
                            detail if unchanged else "Input was modified"))

    rng = random.Random(20261004)
    if case["id"] == "code-intervals":
        fixed = [[], [[1, 1]], [[3, 4], [1, 2]], [[1, 3], [3, 5]],
                 [[1, 10], [2, 3], [1, 10]], [[-5, -2], [-3, 0], [2, 2]],
                 [[4, 7], [1, 3], [3, 4], [9, 10]], [[2, 2], [1, 1]]]
        for number, intervals in enumerate(fixed):
            expect(f"edge-{number}", intervals, union_reference(intervals))
        for number in range(50):
            intervals = [sorted([rng.randint(-20, 20), rng.randint(-20, 20)])
                         for _ in range(rng.randint(0, 16))]
            expect(f"random-{number}", intervals, union_reference(intervals))
    elif case["id"] == "code-dependencies":
        fixed = [{}, {"A": []}, {"B": [], "A": [], "C": ["A", "B"]},
                 {"A": ["B", "B"], "B": []}, {"A": ["Z"]},
                 {"A": ["A"]}, {"A": ["B"], "B": ["A"]},
                 {"A": [], "B": ["C"], "C": ["B"]},
                 {"Z": [], "A": ["Z"], "B": [], "C": ["A"]}]
        for number, deps in enumerate(fixed):
            try:
                expected = order_reference(deps)
                expect(f"edge-{number}", deps, expected)
            except ValueError:
                expect(f"edge-{number}", deps, raises=True)
        for number in range(50):
            keys = list("ABCDEFGH")[:rng.randint(1, 8)]
            rng.shuffle(keys)
            deps = {key: [earlier for earlier in keys[:index] if rng.random() < .4]
                    for index, key in enumerate(keys)}
            for key in keys:
                if deps[key] and rng.random() < .5:
                    deps[key].append(deps[key][0])
            expect(f"random-{number}", deps, order_reference(deps))
    elif case["id"] == "code-csv":
        fixed = [("", [""]), (",", ["", ""]), ("a,b,", ["a", "b", ""]),
                 ('""', [""]), ('a,"b,c","d""e",', ["a", "b,c", 'd"e', ""]),
                 ('""""', ['"']), ('  x  ," y "', ["  x  ", " y "]),
                 ('"你好,世界",末尾', ["你好,世界", "末尾"])]
        for number, (line, expected) in enumerate(fixed):
            expect(f"edge-{number}", line, expected)
        for number, line in enumerate(['"a', 'a"b', '"a"b', '"a" ', 'a,"b', '"a""']):
            expect(f"invalid-{number}", line, raises=True)
        for number in range(50):
            fields = ["".join(rng.choice('ab,\" 空') for _ in range(rng.randint(0, 8)))
                      for _ in range(rng.randint(1, 8))]
            stream = io.StringIO(newline="")
            csv.writer(stream, lineterminator="\r\n").writerow(fields)
            expect(f"random-{number}", stream.getvalue()[:-2], fields)
    else:
        raise ValueError("Unknown coding case")
    return checks


def general_checks(case: dict, content: str) -> list[dict]:
    identifier = case["id"]
    if identifier == "general-notice":
        text = content.strip()
        paragraphs = re.split(r"\n\s*\n", text)
        fragments = ["周六22:00至周日02:00", "不能提交新任务", "已有任务继续处理",
                     "一次邮件通知", "恢复时间以公告为准"]
        return [check("two-paragraphs", len(paragraphs) == 2),
                check("paragraph-length", len(paragraphs) == 2 and
                      all(40 <= len(part.strip()) <= 90 for part in paragraphs)),
                check("no-heading-list", not re.search(r"(?m)^\s*(?:#|[-*]|\d+[.、])", text)),
                *[check(f"preserve-{fragment}", fragment in text) for fragment in fragments],
                check("no-banned-phrases", not any(word in text for word in
                      ["尊敬", "赋能", "非常", "保证"])),
                check("no-irrelevant-chatter", not any(word in text for word in ["咖啡", "辛苦"])),
                check("no-obvious-invented-terms", not any(word in text for word in
                      ["联系电话", "补偿", "退款", "免费", "收费", "准时恢复"]))]
    try:
        data = json.loads(content.strip())
    except (ValueError, TypeError) as error:
        return [check("strict-json", False, str(error))]
    checks = [check("strict-json", True)]
    if identifier == "general-meeting":
        expected = {"approved_budget_yuan": 60000, "trial_days": 14, "owner": "小林",
                    "fault_rate_percent_max": 1, "completed_orders_min": 300,
                    "rollout_date": None, "full_rollout_approved": False}
        if not isinstance(data, dict):
            return checks + [check("object", False)]
        checks.append(check("exact-keys", set(data) == set(expected)))
        for key, value in expected.items():
            actual = data.get(key, "<missing>")
            valid = actual == value
            if value is None or isinstance(value, bool):
                valid = actual is value
            checks.append(check(key, valid, "" if valid else f"Expected {value!r}; got {actual!r}"))
    elif identifier == "general-probability":
        expected = {"defective_total": 32, "mixed_defect_percent": 3.2,
                    "b_given_defect_percent": 62.5, "new_mixed_defect_percent": 3.7143}
        if not isinstance(data, dict):
            return checks + [check("object", False)]
        checks.append(check("exact-keys", set(data) == set(expected)))
        for key, value in expected.items():
            actual = data.get(key)
            valid = isinstance(actual, (int, float)) and not isinstance(actual, bool) and math.isclose(actual, value, abs_tol=.00005)
            checks.append(check(key, valid, "" if valid else f"Expected {value}; got {actual}"))
    elif identifier == "general-schedule":
        if not isinstance(data, list) or len(data) != 6 or set(map(str, data)) != set("ABCDEF"):
            return checks + [check("six-unique-activities", False)]
        positions = {name: data.index(name) + 1 for name in "ABCDEF"}
        checks.extend([check("six-unique-activities", True),
                       check("F-last", positions["F"] == 6),
                       check("D-immediately-after-B", positions["D"] == positions["B"] + 1),
                       check("C-before-A", positions["C"] < positions["A"]),
                       check("B-before-C", positions["B"] < positions["C"]),
                       check("D-before-E", positions["D"] < positions["E"]),
                       check("E-not-first-or-fifth", positions["E"] not in (1, 5)),
                       check("A-not-first", positions["A"] != 1)])
    else:
        raise ValueError("Unknown general case")
    return checks


def evaluate(case: dict, content: str) -> list[dict]:
    if case["category"] != "coding":
        return general_checks(case, content)
    # Isolation prevents infinite loops from stalling the comparison. Never
    # execute unrestricted model output directly in the host interpreter.
    environment = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP") if key in os.environ}
    try:
        result = subprocess.run([sys.executable, "-I", "-S", str(Path(__file__).resolve()), "--worker"],
                                input=json.dumps({"case": case, "content": content}, ensure_ascii=False),
                                capture_output=True, text=True, encoding="utf-8", timeout=10, env=environment)
        if result.returncode:
            return [check("restricted-execution", False, result.stderr[-1000:])]
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        return [check("execution-timeout", False, "10 second limit exceeded")]


def self_test(cases: list[dict]) -> None:
    references = {
        "code-intervals": '''def merge_intervals(intervals):
    result = []
    for start, end in sorted(intervals):
        if result and start <= result[-1][1]:
            result[-1][1] = max(result[-1][1], end)
        else:
            result.append([start, end])
    return result
''',
        "code-dependencies": '''def build_order(deps):
    if any(x not in deps for values in deps.values() for x in values):
        raise ValueError("missing")
    result = []
    while len(result) < len(deps):
        ready = sorted(k for k, values in deps.items() if k not in result and all(x in result for x in values))
        if not ready:
            raise ValueError("cycle")
        result.append(ready[0])
    return result
''',
        "code-csv": '''def parse_csv_line(line):
    result, field, state, i = [], "", "start", 0
    while i < len(line):
        c = line[i]
        if state == "quoted":
            if c == '"':
                if i + 1 < len(line) and line[i + 1] == '"':
                    field += '"'
                    i += 1
                else:
                    state = "closed"
            else:
                field += c
        elif c == ',':
            result.append(field)
            field, state = "", "start"
        elif state == "closed":
            raise ValueError("after quote")
        elif c == '"':
            if state != "start":
                raise ValueError("inner quote")
            state = "quoted"
        else:
            field += c
            state = "plain"
        i += 1
    if state == "quoted":
        raise ValueError("unclosed")
    return result + [field]
''',
        "general-meeting": json.dumps({"approved_budget_yuan": 60000, "trial_days": 14,
                                       "owner": "小林", "fault_rate_percent_max": 1,
                                       "completed_orders_min": 300, "rollout_date": None,
                                       "full_rollout_approved": False}, ensure_ascii=False),
        "general-probability": json.dumps({"defective_total": 32, "mixed_defect_percent": 3.2,
                                          "b_given_defect_percent": 62.5, "new_mixed_defect_percent": 3.7143}),
        "general-schedule": '["B","D","E","C","A","F"]',
        "general-notice": "系统计划于周六22:00至周日02:00进行维护。维护期间不能提交新任务，已有任务继续处理，请您提前安排提交时间。\n\n若维护延期，系统会发送一次邮件通知，恢复时间以公告为准。请留意公告中的最新进展，并在恢复后再提交新任务。",
    }
    for case in cases:
        checks = evaluate(case, references[case["id"]])
        assert checks and all(item["passed"] for item in checks), (case["id"], checks)
        wrong = "def " + case.get("entrypoint", "unused") + "(value):\n    return []" if case["category"] == "coding" else "{}"
        assert not all(item["passed"] for item in evaluate(case, wrong)), case["id"]
        print(json.dumps({"self_test": case["id"], "checks": len(checks), "status": "OK"}), flush=True)
    schedule_case = next(case for case in cases if case["id"] == "general-schedule")
    solutions = [order for order in itertools.permutations("ABCDEF")
                 if all(item["passed"] for item in general_checks(schedule_case, json.dumps(order)))]
    assert len(solutions) == 2, solutions
    for forbidden in ['import os\ndef f(x): return x', 'def f(x): return open("secret")',
                      'def f(x): return x.__class__']:
        try:
            ns = code_namespace(forbidden)
            ns["f"](1)
        except (ValueError, NameError):
            continue
        raise AssertionError("Unsafe code was not blocked")
    print("Grader positive/negative controls and safety guards: OK", flush=True)


def benchmark(args, cases: list[dict]) -> None:
    import requests
    session = requests.Session()
    session.trust_env = False
    def get(path):
        response = session.get(API + path, timeout=10)
        response.raise_for_status()
        return response.json()
    def post(path, payload):
        response = session.post(API + path, json=payload, timeout=(10, 240))
        response.raise_for_status()
        return response.json()

    tags = {item["name"]: item for item in get("/api/tags")["models"]}
    if any(model not in tags for model in args.models):
        raise RuntimeError("Every model must already be installed; this script does not download models")
    if get("/api/ps").get("models"):
        raise RuntimeError("A model is already loaded; run when the service is idle")
    options = {"num_ctx": 16384, "num_batch": 128, "temperature": .6,
               "top_p": .95, "top_k": 20, "repeat_penalty": 1.0,
               "presence_penalty": 0, "seed": 42}
    report = {"test_date": "2026-10-04", "models": [tags[model] for model in args.models],
              "options": options, "direct_token_budget": 3072, "thinking_token_budget": args.thinking_token_budget,
              "thinking_cases": args.thinking_cases, "modes": args.modes,
              "sampling_profile": args.sampling_profile, "cases": cases, "records": [],
              "limitations": ["Seven constructed tasks, one generation per task/mode; not a general leaderboard",
                              "Same prompt, context, sampling and output budget; different weight precision",
                              "Code checks pure functions, not repository editing, tool use or frontend work",
                              "Automatic notice checks do not replace human review of writing quality"]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    def save():
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    save()
    for model in args.models:
        if get("/api/ps").get("models"):
            raise RuntimeError("Another workload started; refusing to unload it")
        try:
            post("/api/chat", {"model": model, "messages": [{"role": "user", "content": "Reply OK"}],
                               "think": False, "stream": False, "keep_alive": "5m",
                               "options": {**options, "num_predict": 8}})
            loaded = next(item for item in get("/api/ps")["models"] if item["name"] == model)
            full_gpu = loaded["size"] == loaded["size_vram"]
            print(json.dumps({"loaded": model, "full_gpu": full_gpu,
                              "context": loaded.get("context_length")}), flush=True)
            if not full_gpu:
                raise RuntimeError("The same 16K context did not fit fully on GPU; avoid misleading timing comparison")
            for thinking in (False, True):
                if ("thinking" if thinking else "direct") not in args.modes:
                    continue
                selected = cases if not thinking else [case for case in cases if case["id"] in args.thinking_cases]
                for case in selected:
                    case_options = {**options, "min_p": 0.0}
                    if args.sampling_profile == "task-aware" and case["category"] == "general":
                        case_options.update(temperature=1.0 if thinking else .7,
                                            top_p=.95 if thinking else .8, presence_penalty=1.5)
                    print(json.dumps({"starting": case["id"], "model": model, "thinking": thinking}), flush=True)
                    started = time.monotonic()
                    result = post("/api/chat", {"model": model, "messages": [
                        {"role": "system", "content": "完成用户任务，严格遵守规格，不添加未给出的事实。"},
                        {"role": "user", "content": case["prompt"]}], "think": thinking,
                        "stream": False, "keep_alive": "5m",
                        "options": {**case_options, "num_predict": args.thinking_token_budget if thinking else 3072}})
                    elapsed = round(time.monotonic() - started, 2)
                    content = result.get("message", {}).get("content", "")
                    try:
                        checks = evaluate(case, content)
                    except Exception as error:
                        checks = [check("evaluation", False, f"{type(error).__name__}: {error}")]
                    if result.get("done_reason") == "length":
                        checks.append(check("token-budget", False, "Output exhausted the budget; not proof of inability"))
                    state = next(item for item in get("/api/ps")["models"] if item["name"] == model)
                    record = {"model": model, "case": case["id"], "category": case["category"],
                              "thinking": thinking, "elapsed_seconds": elapsed,
                              "sampling_options": case_options,
                              "output_tokens": result.get("eval_count"),
                              "prompt_tokens": result.get("prompt_eval_count"),
                              "tokens_per_second": round(result.get("eval_count", 0) * 1e9 / max(result.get("eval_duration", 1), 1), 2),
                              "done_reason": result.get("done_reason"),
                              "reasoning_characters": len(result.get("message", {}).get("thinking", "")),
                              "gpu": {key: state.get(key) for key in ("size", "size_vram", "context_length")},
                              "passed": bool(checks) and all(item["passed"] for item in checks),
                              "checks": checks, "output": content}
                    report["records"].append(record)
                    save()
                    failed_checks = [item for item in checks if not item["passed"]]
                    print(json.dumps({key: record[key] for key in ("model", "case", "thinking", "elapsed_seconds", "done_reason", "passed")}
                                     | {"failed_count": len(failed_checks), "failed_checks": failed_checks[:5]}, ensure_ascii=False), flush=True)
        finally:
            # Only the diagnostic workload's model is released, not other models.
            post("/api/generate", {"model": model, "keep_alive": 0})
    report["rollup"] = []
    for model in args.models:
        for thinking in (False, True):
            records = [item for item in report["records"] if item["model"] == model and item["thinking"] == thinking]
            if records:
                report["rollup"].append({"model": model, "thinking": thinking,
                                         "passed": sum(item["passed"] for item in records), "total": len(records),
                                         "median_seconds": round(statistics.median(item["elapsed_seconds"] for item in records), 2)})
    save()
    print(json.dumps({"complete": str(args.output), "rollup": report["rollup"]}, ensure_ascii=False), flush=True)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if "--worker" in sys.argv:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
        payload = json.loads(sys.stdin.read())
        try:
            checks = coding_checks(payload["case"], payload["content"])
        except Exception as error:
            checks = [check("restricted-execution", False, f"{type(error).__name__}: {error}")]
        print(json.dumps(checks, ensure_ascii=False))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--models", nargs="+", default=["qwen3.5:9b-q8_0", "bili-summary:35b-iq2xxs"])
    parser.add_argument("--thinking-cases", nargs="*", default=["code-csv", "general-probability"])
    parser.add_argument("--case-ids", nargs="+")
    parser.add_argument("--modes", nargs="+", choices=("direct", "thinking"), default=["direct", "thinking"])
    parser.add_argument("--thinking-token-budget", type=int, choices=(4096, 8192), default=4096)
    parser.add_argument("--sampling-profile", choices=("controlled", "task-aware"), default="controlled")
    parser.add_argument("--output", type=Path, default=ROOT / "outputs/coding-general-comparison.json")
    args = parser.parse_args()
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    if args.case_ids:
        cases = [case for case in cases if case["id"] in args.case_ids]
        if len(cases) != len(set(args.case_ids)):
            raise ValueError("Unknown evaluation case ID")
    if args.self_test:
        self_test(cases)
    else:
        benchmark(args, cases)


if __name__ == "__main__":
    main()
