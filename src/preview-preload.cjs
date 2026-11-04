// 인쇄 미리보기 창의 단추를 잇는다. 미리보기 HTML은 스크립트를 쓰지 않는다(CSP).
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const send = (action) => ipcRenderer.send("preview:action", action);
  for (const id of ["print", "pdf", "close"]) {
    document.getElementById(id)?.addEventListener("click", () => send(id));
  }

  let zoom = 1;
  const label = document.getElementById("zoom-label");
  const applyZoom = () => {
    document.documentElement.style.setProperty("--zoom", String(zoom));
    if (label) label.textContent = `${Math.round(zoom * 100)}%`;
  };
  document.getElementById("zoom-in")?.addEventListener("click", () => {
    zoom = Math.min(3, zoom + 0.25);
    applyZoom();
  });
  document.getElementById("zoom-out")?.addEventListener("click", () => {
    zoom = Math.max(0.25, zoom - 0.25);
    applyZoom();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") send("close");
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyP") {
      event.preventDefault();
      send("print");
    }
  });
});
