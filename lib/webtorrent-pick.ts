const VIDEO = /\.(mp4|m4v|mkv|webm|mov)$/i;

/** Same selection rules as the debrid resolver: fileIdx → SxxEyy match → largest video. */
export function pickFileForPlayback<T extends { index: number; name: string; size: number }>(files: T[], fileIdx?: number, season?: number, episode?: number): T | undefined {
  if (fileIdx != null && files[fileIdx]) return files[fileIdx];
  const videos = files.filter((f) => VIDEO.test(f.name) && !/sample/i.test(f.name));
  if (season != null && episode != null) {
    const re = new RegExp(`s0?${season}[ ._-]?e0?${episode}(?!\\d)|\\b${season}x0?${episode}(?!\\d)`, 'i');
    const m = videos.find((f) => re.test(f.name));
    if (m) return m;
  }
  return [...(videos.length ? videos : files)].sort((a, b) => b.size - a.size)[0];
}
