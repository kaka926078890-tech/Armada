/** Shared WKWebView / Android WebView height script. Keep iOS + Android copies identical. */
export const MEASURE_JS =
  "(function(){var b=document.body;if(!b||!b.lastElementChild)return 1;var last=b.lastElementChild;var mb=parseFloat(getComputedStyle(last).marginBottom)||0;return Math.ceil(Math.max(last.getBoundingClientRect().bottom+mb-b.getBoundingClientRect().top,1));})()";
