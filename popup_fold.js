// Equipe, Radar, Aviso e Planilha começam recolhidos: só o cabeçalho (com o estado e o liga/desliga) fica à vista.
document.addEventListener("DOMContentLoaded", () => {
  for (const id of ["teamBox", "radarBox", "notifyBox", "exportBox"]) {
    const box = document.getElementById(id);
    const head = box?.querySelector(".team-head, .radar-head");
    const title = head?.querySelector(".team-title, .radar-title");
    if (!title) continue;

    const open = aberto => {
      box.classList.toggle("folded", !aberto);
      title.setAttribute("aria-expanded", String(aberto));
    };
    box.classList.add("foldable");
    title.setAttribute("role", "button");
    title.tabIndex = 0;
    open(false);

    head.addEventListener("click", event => {
      if (!event.target.closest(".apple-switch")) open(box.classList.contains("folded"));
    });
    title.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open(box.classList.contains("folded"));
    });
    // Ligou ou desligou pelo cabeçalho: abre para a resposta (ou o erro) aparecer.
    head.querySelector("input[type='checkbox']")?.addEventListener("change", () => open(true));
  }
});
