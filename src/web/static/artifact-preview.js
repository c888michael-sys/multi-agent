/* Builds a self-contained static preview document. The caller must put it in
 * an opaque-origin iframe; this file never grants generated code app access. */
(function () {
  function normalise(path) {
    const parts = [];
    for (const part of String(path || '').replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { parts.pop(); continue; }
      parts.push(part);
    }
    return parts.join('/');
  }

  function resolvePath(from, reference) {
    if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) return null;
    const target = reference.split(/[?#]/, 1)[0];
    return normalise(normalise(from).split('/').slice(0, -1).concat(target.split('/')).join('/'));
  }

  function escapeScript(source) {
    return String(source).replace(/<\/script/gi, '<\\/script');
  }

  function buildPreviewDocument(candidates) {
    const files = new Map();
    for (const candidate of candidates || []) {
      if (!candidate || typeof candidate.path !== 'string' || typeof candidate.content !== 'string') continue;
      files.set(normalise(candidate.path), candidate.content);
    }
    const paths = [...files.keys()];
    const htmlPath = paths.find((path) => /(^|\/)index\.html?$/i.test(path)) || paths.find((path) => /\.html?$/i.test(path));
    if (!htmlPath) return { ok: false, error: 'Source preview is available for static HTML file sets only.' };

    let html = files.get(htmlPath);
    html = html.replace(/<base\b[^>]*>/gi, '');
    html = html.replace(/<link\b(?=[^>]*\brel\s*=\s*["']?stylesheet\b)[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>/gi, (tag, _quote, href) => {
      const css = files.get(resolvePath(htmlPath, href));
      return css === undefined ? tag : '<style data-artifact-preview="embedded">' + css + '</style>';
    });
    html = html.replace(/<script\b(?=[^>]*\bsrc\s*=\s*(["']))[^>]*\bsrc\s*=\s*(["'])([^"']+)\2[^>]*>\s*<\/script>/gi, (tag, _firstQuote, _quote, src) => {
      const script = files.get(resolvePath(htmlPath, src));
      return script === undefined ? tag : '<script data-artifact-preview="embedded">' + escapeScript(script) + '</script>';
    });

    const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
    if (/<head\b[^>]*>/i.test(html)) {
      html = html.replace(/<head\b[^>]*>/i, (head) => head + '<meta http-equiv="Content-Security-Policy" content="' + csp + '">');
    } else {
      html = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="' + csp + '"></head><body>' + html + '</body></html>';
    }
    return { ok: true, htmlPath, document: html };
  }

  window.ArtifactPreview = { buildPreviewDocument };
}());
