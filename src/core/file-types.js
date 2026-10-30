/* ---------- file types (shared with the server) ---------- */
export function fileType(name) {
  const e = (name.split('.').pop() || '').toLowerCase();
  if (e === 'fig') return 'fig';
  if (e === 'pdf') return 'pdf';
  if (['zip', 'rar', '7z'].includes(e)) return 'zip';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(e)) return 'img';
  if (['xlsx', 'xls', 'csv', 'numbers'].includes(e)) return 'sheet';
  if (['doc', 'docx', 'txt', 'md', 'pages', 'rtf'].includes(e)) return 'doc';
  if (['js', 'ts', 'json', 'html', 'css', 'py'].includes(e)) return 'code';
  return 'other';
}
export function fsize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return Math.round(b / 1024) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
