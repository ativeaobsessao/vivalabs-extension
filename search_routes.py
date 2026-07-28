with open("index.js", "r", encoding="utf-8") as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    if 'app.post("/api/salvar"' in line or 'app.post(\'/api/salvar\'' in line:
        print(f"app.post('/api/salvar') at line {i+1}")
    if 'app.post("/admin/salvar"' in line or 'app.post(\'/admin/salvar\'' in line:
        print(f"app.post('/admin/salvar') at line {i+1}")
    if 'app.post("/admin/funis/remover-node"' in line or 'app.post(\'/admin/funis/remover-node\'' in line:
        print(f"funnel remover-node at line {i+1}")
