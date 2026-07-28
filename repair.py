import os
import re

with open('content.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. We will extract the good 'setupSidebarInteractions' body from line 703 to 794 (approx)
good_setup_match = re.search(r'function setupSidebarInteractions\(\) \{(.*?)\n\}', content, re.DOTALL)
if good_setup_match:
    good_setup_body = good_setup_match.group(1)
    
# 2. We will extract the rest of the original setupSidebarInteractions (save, export, etc)
# It starts around 'const applyFilterBtn = document.getElementById("viva-btn-apply-filter");' and goes to the end of the function
old_setup_match = re.search(r'(  // Garante que o status do monitor.*)function checkMonitoredStatus', content, re.DOTALL)
if old_setup_match:
    old_setup_body = old_setup_match.group(1)
    # the group ends with '}' that closes the function
    old_setup_body = old_setup_body.strip()
    if old_setup_body.endswith('}'):
        old_setup_body = old_setup_body[:-1]

# 3. Create the perfect `injectSidebar` HTML
perfect_inject = '''
function injectSidebar() {
  if (document.getElementById("viva-sidebar")) return;

  const sidebar = document.createElement("div");
  sidebar.id = "viva-sidebar";
  sidebar.className = "viva-sidebar viva-el";

  sidebar.innerHTML = `
    <div class="viva-sidebar-header">
      <div style="display:flex; align-items:center; gap:8px;">
        <h3 class="viva-sidebar-title">VIVA Labs Monitor</h3>
        <span class="viva-scale-score viva-score-low" id="viva-sidebar-status">✓ Conectado</span>
      </div>
      <button class="viva-sidebar-minimize-btn" id="viva-btn-minimize" title="Minimizar">_</button>
    </div>
    <div class="viva-sidebar-content">
      
      <!-- Seção 1: Controle & Filtros (Topo) -->
      <div class="viva-panel-section">
        <h4 class="viva-section-title">Controle & Filtros</h4>
        
        <div class="viva-form-group" style="margin-bottom:8px">
          <label class="viva-label" title="Quantidade total de anúncios que o anunciante está rodando (indica volume).">Mínimo de Ads Ativos na Página</label>
          <input type="number" id="viva-filter-min-page" class="viva-input" value="0" min="0" placeholder="Ex: 50" style="width:100%">
        </div>
        
        <div class="viva-form-group" style="margin-bottom:8px">
          <label class="viva-label" title="Quantidade de vezes que o MESMO criativo se repete (indica agressividade na escala).">Mínimo de Ads Duplicados</label>
          <div style="display:flex; gap:6px; align-items:center">
            <input type="number" id="viva-filter-min-dup" class="viva-input" value="0" min="0" placeholder="Ex: 3" style="flex:1">
            <button class="viva-btn viva-btn-primary" id="viva-btn-apply-filter" style="padding:7px 14px !important; font-size:11px; white-space:nowrap; border-radius:8px">Aplicar</button>
          </div>
        </div>

        <div class="viva-switch-row">
          <span title="Rola a página sozinho até o fim da biblioteca para carregar tudo (Fase 1)">Auto-Scroll (Fase 1)</span>
          <label class="viva-switch">
            <input type="checkbox" id="viva-toggle-scroll">
            <span class="viva-slider"></span>
          </label>
        </div>
      </div>

      <div class="viva-divider"></div>

      <!-- Seção 2: Rastreador -->
      <div class="viva-panel-section">
        <h4 class="viva-section-title">Rastrear Competidor</h4>
        
        <div class="viva-form-group">
          <label class="viva-label">Nome da Operação (Automático)</label>
          <input type="text" id="viva-side-name" class="viva-input" placeholder="Ex: VIVA Labs Oficial">
        </div>

        <div style="display:flex; gap:8px;">
          <div class="viva-form-group" style="flex:1">
            <label class="viva-label">GEO</label>
            <input type="text" id="viva-side-geo" class="viva-input" placeholder="Ex: BR">
          </div>
          <div class="viva-form-group" style="flex:2">
            <label class="viva-label">Nicho</label>
            <input type="text" id="viva-side-nicho" class="viva-input" placeholder="Ex: Encapsulados">
          </div>
        </div>

        <div class="viva-form-group" id="viva-group-instagram" style="display:none;">
          <label class="viva-label">Instagram Link (Detectado)</label>
          <input type="text" id="viva-side-instagram" class="viva-input" readonly>
        </div>

        <button class="viva-btn viva-btn-primary" id="viva-side-save" style="margin-top:4px;">Monitorar no VIVA Labs</button>
      </div>

      <div class="viva-divider"></div>

      <!-- Seção 3: Exportação e Ferramentas -->
      <div class="viva-panel-section">
        <div style="display:flex; gap:8px; margin-bottom: 8px;">
          <button class="viva-btn viva-btn-secondary" id="viva-btn-export-csv" style="flex:1;">Exportar CSV</button>
          <button class="viva-btn viva-btn-secondary" id="viva-btn-export-media" style="flex:1;">Baixar Mídias</button>
        </div>
        <button class="viva-btn viva-btn-primary" id="viva-btn-show-ranking" style="width:100%; background-color: #007aff">
          🏆 Ver Top Anunciantes
        </button>
      </div>

    </div>
  `;

  document.body.appendChild(sidebar);
  setupSidebarInteractions();
}
'''

# 4. Now, I will assemble the final file.
# We keep everything up to the FIRST setupSidebarInteractions (line 703)
idx_setup_1 = content.find('function setupSidebarInteractions() {')

# The end of the file starts at checkMonitoredStatus
idx_check = content.find('// Checa em tempo real se o player ou domínio da aba já está cadastrado')

if idx_setup_1 != -1 and idx_check != -1:
    top_part = content[:idx_setup_1]
    
    # We remove the first setupSidebarInteractions, startAutoScroll, stopAutoScroll, openFunnelModal(stub), injectSidebar, setupSidebarInteractions
    
    combined_setup = 'function setupSidebarInteractions() {' + good_setup_body + '\n' + old_setup_body + '\n}\n\n'
    
    scroll_funcs = '''
function startAutoScroll() {
  if (autoScrollTimer) clearInterval(autoScrollTimer);
  console.log("[VIVA] Auto-scroll iniciado.");
  
  autoScrollTimer = setInterval(() => {
    if (!isAutoScrollRunning) return;
    const loadMoreBtns = Array.from(document.querySelectorAll("div[role='button']")).filter(b => b.textContent.includes("Carregar") || b.textContent.includes("Ver mais") || b.textContent.includes("Load more"));
    if (loadMoreBtns.length > 0) loadMoreBtns[0].click();
    window.scrollBy({ top: 1500, behavior: "smooth" });
  }, 4000);
}

function stopAutoScroll() {
  if (autoScrollTimer) {
    clearInterval(autoScrollTimer);
    autoScrollTimer = null;
  }
  isAutoScrollRunning = false;
  console.log("[VIVA] Auto-scroll pausado.");
}
'''
    
    bottom_part = content[idx_check:]
    
    final_code = top_part + perfect_inject + combined_setup + scroll_funcs + bottom_part
    
    with open('content.js', 'w', encoding='utf-8') as f:
        f.write(final_code)
    
    print('SUCCESS: Reconstructed content.js perfectly.')
else:
    print('Failed to find indices')
