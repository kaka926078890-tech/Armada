/* Keep initialize options in sync with hub/web/src/components/MermaidChart.tsx */
(function () {
  var root = document.documentElement;
  var dark = !root || root.getAttribute("data-theme") !== "light";
  function notify() {
    try { window.webkit.messageHandlers.mermaidDone.postMessage("ok"); } catch (e) {}
    try {
      if (window.ArmadaMermaid && window.ArmadaMermaid.done) window.ArmadaMermaid.done();
    } catch (e2) {}
  }
  function go() {
    if (!window.mermaid) { notify(); return; }
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      suppressErrorRendering: true,
      theme: dark ? "dark" : "default",
      themeVariables: {
        background: "transparent",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
      }
    });
    Promise.resolve(window.mermaid.run({ querySelector: ".mermaid", suppressErrors: true })).then(notify, notify);
  }
  go();
})();
