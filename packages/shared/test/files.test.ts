import { describe, expect, it } from 'vitest';
import { previewKind, safeFileName, startUploadSchema } from '../src/index.js';

describe('file names', () => {
  it('keep their look, without anything that could be read as a path or a control code', () => {
    expect(safeFileName('Relatório final.pdf')).toBe('Relatório final.pdf');
    expect(safeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeFileName('a\\b\u0000c\nd')).toBe('a_b_c_d');
    expect(safeFileName('   ')).toBe('arquivo');
    expect(safeFileName('x'.repeat(300))).toHaveLength(255);
  });

  it('are accepted by the server exactly when they are already safe', () => {
    const base = { size: 1, type: '' };
    expect(startUploadSchema.safeParse({ ...base, name: 'foto.png' }).success).toBe(true);
    expect(startUploadSchema.safeParse({ ...base, name: 'pasta/foto.png' }).success).toBe(false);
    expect(startUploadSchema.safeParse({ ...base, name: 'foto\u0007.png' }).success).toBe(false);
    for (const name of ['../x', 'a\\b', 'tab\there', 'x'.repeat(300)]) {
      expect(startUploadSchema.safeParse({ ...base, name: safeFileName(name) }).success).toBe(true);
    }
  });
});

describe('showing a file in the page', () => {
  it('only for images, audio and video that cannot run anything', () => {
    expect(previewKind('image/png')).toBe('image');
    expect(previewKind('audio/mpeg')).toBe('audio');
    expect(previewKind('video/webm')).toBe('video');
    for (const type of ['image/svg+xml', 'text/html', 'application/pdf', 'video/x-unknown', null]) {
      expect(previewKind(type)).toBeNull();
    }
  });
});
