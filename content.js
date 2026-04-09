(async () => {
    const SERVER_URL = 'http://127.0.0.1:5000/save-backup';

    console.log("Iniciando processamento completo...");

    // 1. Corrigir classes de layout (ML-3, etc)
    document.querySelectorAll('[class*="-ml-3"][class*="@md:-ml-6"]').forEach(el => {
        el.classList.remove("flex");
    });

    // 2. Embutir CSS (Transforma <link> em <style>)
    const linksCSS = document.querySelectorAll("link[rel='stylesheet']");
    for (const link of linksCSS) {
        try {
            const res = await fetch(link.href);
            const css = await res.text();
            const style = document.createElement("style");
            style.innerHTML = css;
            link.replaceWith(style);
        } catch (e) { console.log("Erro ao embutir CSS:", link.href); }
    }

    // 3. Capturar links de mídias para o servidor baixar
    const mediaLinks = Array.from(new Set(
        Array.from(document.querySelectorAll('img, video, source'))
        .map(el => el.src || el.currentSrc || el.getAttribute('data-src'))
        .filter(src => src && src.startsWith('http'))
    ));

    // 4. Limpar scripts para o HTML ficar "estático" e leve
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("script, iframe, ins").forEach(el => el.remove());
    
    // Remove o painel de UI se existir no clone
    const ui = clone.querySelector('#backup-panel');
    if(ui) ui.remove();

    const finalHtml = clone.outerHTML;

    // 5. Enviar tudo para o Node via Fetch (ou Clipboard se falhar)
    try {
        console.log("Enviando para o servidor...");
        const response = await fetch(SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                html: finalHtml,
                links: mediaLinks,
                title: document.title
            })
        });

        if (response.ok) {
            alert("✅ Backup enviado! HTML e Mídias estão sendo salvos no servidor.");
        } else {
            throw new Error("Erro no servidor");
        }
    } catch (err) {
        console.log("Falha no envio direto (CORS/Mixed Content). Copiando pacote para o Ctrl+V...");
        const fullPackage = JSON.stringify({ html: finalHtml, links: mediaLinks });
        const el = document.createElement('textarea');
        el.value = fullPackage;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        alert("CORS bloqueou o envio. O pacote foi copiado! Cole no dashboard do servidor (http://localhost:5000)");
        window.open('http://localhost:5000', '_blank');
    }
})();