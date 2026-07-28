import os
import re

with open('content.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Let's cleanly replace the entire setupSidebarInteractions function.
# We'll use regex to find the start of setupSidebarInteractions and the start of startAutoScroll
idx_start = content.find('function setupSidebarInteractions() {')
idx_end = content.find('function startAutoScroll() {')

if idx_start != -1 and idx_end != -1:
    top_part = content[:idx_start]
    bottom_part = content[idx_end:]
    
    clean_setup = '''function setupSidebarInteractions() {
  // 1. Minimize Button
  const minimizeBtn = document.getElementById("viva-btn-minimize");
  if (minimizeBtn) {
    minimizeBtn.addEventListener("click", () => {
      const sidebar = document.getElementById("viva-sidebar");
      if (sidebar) sidebar.classList.toggle("viva-minimized");
    });
  }

  // 2. Initial Data for Tracker
  const pageTitle = getPageNameFromHeader();
  const nameInput = document.getElementById("viva-side-name");
  if (nameInput) nameInput.value = pageTitle || "Competidor Meta";
  
  const geoInput = document.getElementById("viva-side-geo");
  if (geoInput) {
    const params = new URLSearchParams(window.location.search);
    const countryParam = params.get("country");
    geoInput.value = countryParam ? countryParam.toUpperCase() : "US";
  }

  const isPage = window.location.href.includes("view_all_page_id=");
  const igGroup = document.getElementById("viva-group-instagram");
  const igInput = document.getElementById("viva-side-instagram");
  
  if (isPage && igGroup && igInput) {
    igGroup.style.display = "flex";
    const igUrl = getInstagramUrlFromHeader();
    igInput.value = igUrl ? igUrl : "Instagram não detectado";
    if (igUrl) {
      igInput.style.cursor = "pointer";
      igInput.style.opacity = "1";
      igInput.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(igUrl).then(() => {
          igInput.classList.add("viva-url-input-copied");
          const originalVal = igInput.value;
          igInput.value = "Copiado e abrindo! ✓";
          setTimeout(() => {
            igInput.classList.remove("viva-url-input-copied");
            igInput.value = originalVal;
          }, 1200);
        });
        window.open(igUrl, "_blank");
      });
    } else {
      igInput.style.cursor = "not-allowed";
      igInput.style.opacity = "0.5";
    }
  }

  // 3. Monitor Status Check
  if (pageTitle && pageTitle.trim() && pageTitle !== "Carregando...") {
    checkMonitoredStatus(pageTitle);
  }

  // 4. Dual Filters & Auto-Scroll
  const minPageInput = document.getElementById("viva-filter-min-page");
  const minDupInput = document.getElementById("viva-filter-min-dup");
  const applyBtn = document.getElementById("viva-btn-apply-filter");
  const scrollToggle = document.getElementById("viva-toggle-scroll");

  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      minPageAds = parseInt(minPageInput.value, 10) || 0;
      minDupAds = parseInt(minDupInput.value, 10) || 0;
      
      // Stop auto-scroll when applying filters
      isAutoScrollRunning = false; 
      if (scrollToggle) scrollToggle.checked = false;
      stopAutoScroll();
      
      processCards();
      
      applyBtn.textContent = "Aplicado ✓";
      applyBtn.style.backgroundColor = "var(--viva-success)";
      setTimeout(() => {
        applyBtn.textContent = "Aplicar";
        applyBtn.style.backgroundColor = "var(--viva-accent)";
      }, 1500);
    });
  }

  if (scrollToggle) {
    scrollToggle.addEventListener("change", (e) => {
      isAutoScrollRunning = e.target.checked;
      if (isAutoScrollRunning) {
        document.querySelectorAll('.viva-flex-override').forEach(el => el.classList.remove('viva-flex-override'));
        startAutoScroll();
      } else {
        stopAutoScroll();
        processCards(); 
      }
    });
  }

  // 5. Save/Monitor Competitor
  const saveBtn = document.getElementById("viva-side-save");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const nome = document.getElementById("viva-side-name").value.trim();
      const geo = document.getElementById("viva-side-geo").value.trim();
      const nicho = document.getElementById("viva-side-nicho").value.trim();
      const url = window.location.href;
      const isDomain = !url.includes("view_all_page_id=");
      const igUrlToSend = isPage ? getInstagramUrlFromHeader() : null;
      
      if (!nome) return alert("Por favor, preencha o Nome.");

      saveBtn.textContent = "Salvando...";
      saveBtn.disabled = true;

      try {
        const res = await fetch(`${API_URL}/api/salvar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nome: nome,
            url: url,
            tipo: isDomain ? "dominio" : "pagina",
            geo: geo,
            nicho: nicho,
            instagram_url: igUrlToSend || null,
            ads_count_inicial: activeCardData.length
          })
        });

        if (res.ok) {
          saveBtn.textContent = "Monitorando ✓";
          saveBtn.style.backgroundColor = "rgba(142, 142, 147, 0.16)";
          saveBtn.style.color = "var(--viva-text)";
          saveBtn.disabled = true;
          if (typeof fetchMonitoredPages === 'function') await fetchMonitoredPages();
        } else {
          alert("Erro ao cadastrar player no monitor.");
          saveBtn.textContent = "Monitorar no VIVA Labs";
          saveBtn.disabled = false;
        }
      } catch (err) {
        alert("Erro de comunicação com o servidor.");
        saveBtn.textContent = "Monitorar no VIVA Labs";
        saveBtn.disabled = false;
      }
    });
  }

  // 6. Export CSV
  const exportCsvBtn = document.getElementById("viva-btn-export-csv");
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener("click", () => {
      const cards = activeCardData.filter(item => item.card.style.display !== "none");
      let csvContent = "\uFEFF"; 
      csvContent += "Anunciante;Título (Headline);Descrição (Copy);URL Destino;URL Mídia;Dias Ativo\\n";

      cards.forEach(item => {
        const data = item.data;
        const cleanTitle = data.title.replace(/;/g, ",").replace(/\\n/g, " ");
        const cleanDesc = data.description.replace(/;/g, ",").replace(/\\n/g, " ");
        const ageStr = data.adAgeDays !== null ? data.adAgeDays : "Desconhecido";
        csvContent += `"${data.advertiserName}";"${cleanTitle}";"${cleanDesc}";"${data.destUrl || ""}";"${data.mediaUrl || ""}";"${ageStr}"\\n`;
      });

      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.setAttribute("download", `viva_benchmark_export_${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  }

  // 7. Export Media
  const exportMediaBtn = document.getElementById("viva-btn-export-media");
  if (exportMediaBtn) {
    exportMediaBtn.addEventListener("click", () => {
      const cards = activeCardData.filter(item => item.card.style.display !== "none");
      const items = [];

      cards.forEach(item => {
        if (item.data.mediaUrl) {
          const isVideo = item.data.mediaUrl.includes(".mp4") || item.card.querySelector("video");
          const ext = isVideo ? "mp4" : "jpg";
          const cleanName = item.data.advertiserName.toLowerCase().replace(/[^a-z0-9]/g, "_");
          const filename = `viva_batch_${cleanName}_${Date.now()}.${ext}`;
          items.push({ url: item.data.mediaUrl, filename: filename });
        }
      });

      if (items.length === 0) return alert("Nenhuma mídia de imagem ou vídeo encontrada na tela para baixar.");

      exportMediaBtn.textContent = `Baixando ${items.length}...`;
      exportMediaBtn.disabled = true;

      chrome.runtime.sendMessage({
        action: "download_batch",
        items: items
      }, (res) => {
        setTimeout(() => {
          exportMediaBtn.textContent = "Baixar Mídias";
          exportMediaBtn.disabled = false;
        }, 3000);
      });
    });
  }
}

'''
    
    with open('content.js', 'w', encoding='utf-8') as f:
        f.write(top_part + clean_setup + bottom_part)
    
    print('SUCCESS: Replaced setupSidebarInteractions.')
else:
    print('Failed to find indices')
