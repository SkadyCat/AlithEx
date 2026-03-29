import argparse
import json
import sys
import urllib.error
import urllib.request

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Debug helper for POST /launch-agent."
    )
    parser.add_argument(
        "--url",
        default="http://localhost:8765/launch-agent",
        help="Target launch-agent URL.",
    )
    parser.add_argument(
        "--workspace",
        default="agent_test",
        help="Workspace name sent in the JSON body.",
    )
    parser.add_argument(
        "--model",
        default="",
        help="Optional model value to include in the JSON body.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=15.0,
        help="Request timeout in seconds.",
    )
    args = parser.parse_args()

    payload = {"workspace": args.workspace}
    if args.model:
        payload["model"] = args.model

    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        args.url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    print(f"POST {args.url}")
    print(json.dumps(payload, ensure_ascii=False, indent=2))

    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            print(f"HTTP {response.status}")
            try:
                print(json.dumps(json.loads(raw), ensure_ascii=False, indent=2))
            except json.JSONDecodeError:
                print(raw)
            return 0
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        print(f"HTTP {exc.code}", file=sys.stderr)
        try:
            print(json.dumps(json.loads(raw), ensure_ascii=False, indent=2), file=sys.stderr)
        except json.JSONDecodeError:
            print(raw, file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"Request failed: {exc}", file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
