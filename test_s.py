#!/usr/bin/env python3
import requests
import json
import sys

BASE = "http://localhost:8080/v1"

def first_model_id():
    r = requests.get(f"{BASE}/models")
    r.raise_for_status()
    j = r.json()
    return j["data"][0]["id"]

def stream_chat(model_id):
    url = f"{BASE}/chat/completions"
    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": "Say a short friendly hello and one tip for writing clean code."}],
        "stream": True
    }
    with requests.post(url, json=payload, stream=True, timeout=600) as resp:
        resp.raise_for_status()
        # Iterate over lines -- handle SSE ("data: ...") and raw JSON per-line
        for raw in resp.iter_lines(decode_unicode=True):
            if raw is None:
                continue
            line = raw.strip()
            if not line:
                continue
            # SSE style: "data: {...}" or "data: [DONE]"
            if line.startswith("data:"):
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    print("", flush=True)  # newline
                    break
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
            else:
                # maybe raw JSON
                try:
                    obj = json.loads(line)
                except Exception:
                    continue

            # Extract token / delta content used by many streaming APIs
            text = ""
            # try delta.content
            try:
                for ch in obj.get("choices", []):
                    # delta style
                    delta = ch.get("delta", {})
                    if isinstance(delta, dict) and delta.get("content"):
                        text += delta.get("content", "")
                    # old-style text
                    elif ch.get("text"):
                        text += ch.get("text", "")
            except Exception:
                pass

            if text:
                # print without newline so streaming looks natural
                sys.stdout.write(text)
                sys.stdout.flush()

if __name__ == "__main__":
    mid = first_model_id()
    print(f"Using model: {mid}", file=sys.stderr)
    stream_chat(mid)

