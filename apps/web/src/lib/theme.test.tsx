import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDesktopViewport } from '@/test/render';
import { ThemeProvider, resolveTheme, useTheme } from './theme';

function Probe() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <>
      <output>{`${preference}:${resolved}`}</output>
      <button type="button" onClick={() => setPreference('dark')}>
        dark
      </button>
      <button type="button" onClick={() => setPreference('system')}>
        system
      </button>
    </>
  );
}

describe('resolveTheme', () => {
  it('follows the OS only for the system preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('ThemeProvider', () => {
  it('defaults to the light theme', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('light:light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('applies and persists an explicit choice', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => screen.getByRole('button', { name: 'dark' }).click());

    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('pulsedesk-theme')).toBe('dark');
  });

  it('restores a saved preference', () => {
    localStorage.setItem('pulsedesk-theme', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('dark:dark');
  });

  it('resolves "system" from prefers-color-scheme', () => {
    useDesktopViewport(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => screen.getByRole('button', { name: 'system' }).click());
    expect(screen.getByRole('status')).toHaveTextContent('system:dark');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('ignores corrupted stored values', () => {
    localStorage.setItem('pulsedesk-theme', 'neon');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('light:light');
  });
});
