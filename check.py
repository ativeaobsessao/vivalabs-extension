import re
with open('content.js', 'r', encoding='utf-8') as f:
    text = f.read()

text_stripped = re.sub(r'//.*', '', text)
text_stripped = re.sub(r'/\*.*?\*/', '', text_stripped, flags=re.DOTALL)
text_stripped = re.sub(r'\"(?:\\.|[^\\\"])*\"', '', text_stripped)
text_stripped = re.sub(r'\'(?:\\.|[^\\\'])*\'', '', text_stripped)
text_stripped = re.sub(r'\`(?:\\.|[^\\\`])*\`', '', text_stripped)

print(text_stripped[650:750])
