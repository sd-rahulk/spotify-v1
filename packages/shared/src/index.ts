export const formats: Record<string,string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  opus: 'audio/ogg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav',
};
export const extension = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
export const clock = (seconds: number) => {
  const total = Math.floor(Math.max(0, seconds || 0));
  return Math.floor(total / 60) + ':' + (total % 60).toString().padStart(2, '0');
};
export const bytes = (size: number) => size < 1024 ** 2 ? (size / 1024).toFixed(1) + ' KiB' :
  size < 1024 ** 3 ? (size / 1024 ** 2).toFixed(1) + ' MiB' : (size / 1024 ** 3).toFixed(2) + ' GiB';
