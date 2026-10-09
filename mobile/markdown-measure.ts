/** Shared WKWebView / Android WebView height script. Trailing script/style have no box. Keep iOS + Android copies identical. */
export const MEASURE_JS =
  "(function(){var b=document.body;if(!b||!b.lastElementChild)return 1;var last=b.lastElementChild;while(last&&(last.tagName==='SCRIPT'||last.tagName==='STYLE'))last=last.previousElementSibling;if(!last)return 1;var mb=parseFloat(getComputedStyle(last).marginBottom)||0;return Math.ceil(Math.max(last.getBoundingClientRect().bottom+mb-b.getBoundingClientRect().top,1));})()";
