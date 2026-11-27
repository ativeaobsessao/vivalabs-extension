// Popup enxuto: seções recolhidas ao abrir, abrem no clique (popup.html e popup_fold.js REAIS).
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const DIR = path.resolve(__dirname, "../..");
const read = f => fs.readFileSync(path.join(DIR, f), "utf8");
let fails = 0;
const check = (name, cond) => { if (!cond) { fails++; console.log("FAIL", name); } else console.log("ok  ", name); };

const dom = new JSDOM(read("popup.html").replace(/<script[^>]*><\/script>/g, ""), { runScripts: "outside-only" });
const { window } = dom;
window.eval(read("popup_fold.js"));
window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
const $ = s => window.document.querySelector(s);
const folded = id => $(`#${id}`).classList.contains("folded");
const ids = ["teamBox", "radarBox", "notifyBox", "exportBox"];

check("as quatro seções começam recolhidas", ids.every(folded));
check("botões principais e liga/desliga seguem fora das seções", !$("#openMonitorBtn").closest(".foldable") && !$("#vivaMasterToggle").closest(".foldable"));
$("#teamBox .team-title").click();
check("clique no título abre só aquela seção", !folded("teamBox") && ids.slice(1).every(folded));
$("#teamBox .team-state").click();
check("clique no cabeçalho recolhe de novo", folded("teamBox"));
$("#radarBox .radar-title").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
check("teclado também abre", !folded("radarBox") && $("#radarBox .radar-title").getAttribute("aria-expanded") === "true");
$("#exportAuto").click();
check("ligar pelo cabeçalho abre a seção para ver a resposta", !folded("exportBox") && $("#exportAuto").checked);

console.log(fails ? `${fails} FALHA(S)` : "TUDO OK");
process.exit(fails ? 1 : 0);
