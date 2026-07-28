import os

search_paths = [
    r"C:\Users\User\Desktop",
    r"C:\Users\User\Documents",
    r"C:\Users\User\Downloads",
    r"C:\Users\User\Projects",
    r"C:\Users\User\source"
]

found = []
for base_path in search_paths:
    if not os.path.exists(base_path):
        continue
    print(f"Searching in {base_path}...")
    for root, dirs, files in os.walk(base_path):
        # Evita entrar em node_modules ou .git
        dirs[:] = [d for d in dirs if d not in ('node_modules', '.git', 'AppData', '.gemini')]
        for file in files:
            if file == "index.js":
                full_path = os.path.join(root, file)
                # Verifica se contém "viva-labs" ou express no conteúdo
                try:
                    with open(full_path, "r", encoding="utf-8", errors="ignore") as f:
                        head = f.read(1000)
                        if "viva" in head or "lowticket" in head or "DATABASE_URL" in head:
                            found.append(full_path)
                except Exception:
                    pass

print("\nResults:")
for f in found:
    print(f)
