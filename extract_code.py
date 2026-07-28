import json
import re

path = r"C:\Users\User\.gemini\antigravity\brain\8e92a7a8-186b-4089-b51f-f7d4206b5c3a\.system_generated\logs\transcript_full.jsonl"
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()

user_input_content = None
for line in reversed(lines):
    try:
        data = json.loads(line)
        if data.get("type") == "USER_INPUT":
            user_input_content = data.get("content", "")
            break
    except Exception as e:
        continue

if user_input_content:
    idx = user_input_content.find("import express from")
    if idx != -1:
        code = user_input_content[idx:]
        # Remove trailing markdown closing fence if any
        code = re.sub(r'```\s*$', '', code)
        
        output_path = r"C:\Users\User\.gemini\antigravity\scratch\viva-labs-monitor-extension\index_original.js"
        with open(output_path, "w", encoding="utf-8") as out:
            out.write(code)
        print("Success! Extracted index_original.js")
    else:
        print("Could not find 'import express from' in the user message.")
else:
    print("Could not find USER_INPUT step in transcript.")
