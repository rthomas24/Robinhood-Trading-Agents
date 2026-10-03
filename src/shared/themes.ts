/**
 * Theme catalog — the popular palettes people already run in their editors and
 * terminals, expressed as the app's color tokens. Pure data: the renderer
 * applies `tokens` as CSS variables (renderer/lib/theme.ts). `scheme` drives native color-scheme; `pair` is the light/dark
 * sibling the status-bar toggle flips to.
 */
export type ThemeScheme = 'light' | 'dark'

export type ThemeId =
  | 'light'
  | 'dark'
  | 'midnight'
  | 'github-light'
  | 'github-dark'
  | 'solarized-light'
  | 'solarized-dark'
  | 'catppuccin-latte'
  | 'catppuccin-mocha'
  | 'gruvbox-light'
  | 'gruvbox-dark'
  | 'dracula'
  | 'nord'
  | 'tokyo-night'
  | 'one-dark'
  | 'monokai'
  | 'rose-pine'
  | 'everforest'

/** Token names match `--color-<name>` in index.css. */
export interface ThemeTokens {
  bg: string
  rail: string
  surface: string
  'surface-2': string
  'surface-3': string
  border: string
  muted: string
  text: string
  accent: string
  'accent-fg': string
  bubble: string
  'bubble-fg': string
  up: string
  down: string
  warn: string
  btn: string
  'btn-fg': string
  local: string
}

export interface Theme {
  id: ThemeId
  name: string
  scheme: ThemeScheme
  /** Light/dark sibling for the quick toggle (defaults to 'light' / 'dark'). */
  pair?: ThemeId
  tokens: ThemeTokens
}

const t = (id: ThemeId, name: string, scheme: ThemeScheme, tokens: ThemeTokens, pair?: ThemeId): Theme => ({ id, name, scheme, pair, tokens })

export const THEMES: Theme[] = [
  // Morning fog — the flagship light palette. Neutrals carry a trace of navy
  // (sea light rather than office white), the accent is a calm sea
  // blue, and green/red are darkened until both clear 4.5:1 on the canvas,
  // because every one of them is a number someone is about to act on.
  t('light', 'Morning fog', 'light', {
    bg: '#fbfcfd', rail: '#f4f6f8', surface: '#ffffff', 'surface-2': '#f1f4f7', 'surface-3': '#e5e9ee', border: '#dfe4ea', muted: '#66707c', text: '#11161d',
    accent: '#1f6feb', 'accent-fg': '#ffffff', bubble: '#e8ecf1', 'bubble-fg': '#11161d', up: '#0f8a5f', down: '#d0342c', warn: '#b45309', btn: '#11161d', 'btn-fg': '#ffffff', local: '#0e7490'
  }, 'dark'),
  // Night watch — the flagship dark palette. A tinted near-black (never #000,
  // which makes every hairline disappear), the same hue family as Morning fog
  // so switching is a change of light rather than of identity, and semantic
  // pairs LIGHTENED rather than saturated so figures keep their contrast.
  t('dark', 'Night watch', 'dark', {
    bg: '#0e1116', rail: '#12161c', surface: '#171b22', 'surface-2': '#1d222a', 'surface-3': '#262c36', border: '#262c36', muted: '#8d97a5', text: '#e8ecf2',
    accent: '#4d8dfd', 'accent-fg': '#ffffff', bubble: '#232935', 'bubble-fg': '#e8ecf2', up: '#26b579', down: '#f0554f', warn: '#e0912b', btn: '#e8ecf2', 'btn-fg': '#11161d', local: '#22d3ee'
  }, 'light'),
  t('midnight', 'Midnight (OLED)', 'dark', {
    bg: '#000000', rail: '#0a0a0b', surface: '#111113', 'surface-2': '#19191c', 'surface-3': '#232327', border: '#222226', muted: '#8e8e93', text: '#f5f5f7',
    accent: '#0a84ff', 'accent-fg': '#ffffff', bubble: '#1c1c1f', 'bubble-fg': '#f5f5f7', up: '#30d158', down: '#ff453a', warn: '#ff9f0a', btn: '#f5f5f7', 'btn-fg': '#000000', local: '#64d2ff'
  }, 'light'),
  t('github-light', 'GitHub Light', 'light', {
    bg: '#ffffff', rail: '#f6f8fa', surface: '#ffffff', 'surface-2': '#f6f8fa', 'surface-3': '#eaeef2', border: '#d0d7de', muted: '#656d76', text: '#1f2328',
    accent: '#0969da', 'accent-fg': '#ffffff', bubble: '#eaeef2', 'bubble-fg': '#1f2328', up: '#1a7f37', down: '#cf222e', warn: '#9a6700', btn: '#1f2328', 'btn-fg': '#ffffff', local: '#1b7c83'
  }, 'github-dark'),
  t('github-dark', 'GitHub Dark', 'dark', {
    bg: '#0d1117', rail: '#010409', surface: '#161b22', 'surface-2': '#1c2129', 'surface-3': '#21262d', border: '#30363d', muted: '#8d96a0', text: '#e6edf3',
    accent: '#2f81f7', 'accent-fg': '#ffffff', bubble: '#21262d', 'bubble-fg': '#e6edf3', up: '#3fb950', down: '#f85149', warn: '#d29922', btn: '#e6edf3', 'btn-fg': '#0d1117', local: '#56d4dd'
  }, 'github-light'),
  t('solarized-light', 'Solarized Light', 'light', {
    bg: '#fdf6e3', rail: '#f5eedb', surface: '#fdf6e3', 'surface-2': '#eee8d5', 'surface-3': '#e4ddc8', border: '#e1dac6', muted: '#7a8a8b', text: '#073642',
    accent: '#268bd2', 'accent-fg': '#fdf6e3', bubble: '#eee8d5', 'bubble-fg': '#073642', up: '#859900', down: '#dc322f', warn: '#b58900', btn: '#073642', 'btn-fg': '#fdf6e3', local: '#2aa198'
  }, 'solarized-dark'),
  t('solarized-dark', 'Solarized Dark', 'dark', {
    bg: '#002b36', rail: '#00252f', surface: '#073642', 'surface-2': '#0b3f4d', 'surface-3': '#13505f', border: '#0f4857', muted: '#8fa1a3', text: '#eee8d5',
    accent: '#268bd2', 'accent-fg': '#fdf6e3', bubble: '#0b3f4d', 'bubble-fg': '#eee8d5', up: '#859900', down: '#dc322f', warn: '#b58900', btn: '#eee8d5', 'btn-fg': '#002b36', local: '#2aa198'
  }, 'solarized-light'),
  t('catppuccin-latte', 'Catppuccin Latte', 'light', {
    bg: '#eff1f5', rail: '#e6e9ef', surface: '#ffffff', 'surface-2': '#e6e9ef', 'surface-3': '#dce0e8', border: '#d5d9e3', muted: '#6c6f85', text: '#4c4f69',
    accent: '#1e66f5', 'accent-fg': '#ffffff', bubble: '#e6e9ef', 'bubble-fg': '#4c4f69', up: '#40a02b', down: '#d20f39', warn: '#df8e1d', btn: '#4c4f69', 'btn-fg': '#eff1f5', local: '#179299'
  }, 'catppuccin-mocha'),
  t('catppuccin-mocha', 'Catppuccin Mocha', 'dark', {
    bg: '#1e1e2e', rail: '#181825', surface: '#2a2a3c', 'surface-2': '#313244', 'surface-3': '#45475a', border: '#3b3b52', muted: '#a6adc8', text: '#cdd6f4',
    accent: '#89b4fa', 'accent-fg': '#1e1e2e', bubble: '#313244', 'bubble-fg': '#cdd6f4', up: '#a6e3a1', down: '#f38ba8', warn: '#fab387', btn: '#cdd6f4', 'btn-fg': '#1e1e2e', local: '#94e2d5'
  }, 'catppuccin-latte'),
  t('gruvbox-light', 'Gruvbox Light', 'light', {
    bg: '#fbf1c7', rail: '#f2e5bc', surface: '#fbf1c7', 'surface-2': '#ebdbb2', 'surface-3': '#d5c4a1', border: '#d5c4a1', muted: '#7c6f64', text: '#3c3836',
    accent: '#076678', 'accent-fg': '#fbf1c7', bubble: '#ebdbb2', 'bubble-fg': '#3c3836', up: '#79740e', down: '#9d0006', warn: '#b57614', btn: '#3c3836', 'btn-fg': '#fbf1c7', local: '#427b58'
  }, 'gruvbox-dark'),
  t('gruvbox-dark', 'Gruvbox Dark', 'dark', {
    bg: '#282828', rail: '#1d2021', surface: '#32302f', 'surface-2': '#3c3836', 'surface-3': '#504945', border: '#45403d', muted: '#a89984', text: '#ebdbb2',
    accent: '#83a598', 'accent-fg': '#1d2021', bubble: '#3c3836', 'bubble-fg': '#ebdbb2', up: '#b8bb26', down: '#fb4934', warn: '#fabd2f', btn: '#ebdbb2', 'btn-fg': '#282828', local: '#8ec07c'
  }, 'gruvbox-light'),
  t('dracula', 'Dracula', 'dark', {
    bg: '#282a36', rail: '#21222c', surface: '#2d2f3d', 'surface-2': '#343746', 'surface-3': '#44475a', border: '#3b3e50', muted: '#9aa0bf', text: '#f8f8f2',
    accent: '#bd93f9', 'accent-fg': '#1e1f29', bubble: '#3a3d4e', 'bubble-fg': '#f8f8f2', up: '#50fa7b', down: '#ff5555', warn: '#ffb86c', btn: '#f8f8f2', 'btn-fg': '#282a36', local: '#8be9fd'
  }),
  t('nord', 'Nord', 'dark', {
    bg: '#2e3440', rail: '#2b303b', surface: '#3b4252', 'surface-2': '#434c5e', 'surface-3': '#4c566a', border: '#434c5e', muted: '#9aa5b8', text: '#eceff4',
    accent: '#88c0d0', 'accent-fg': '#2e3440', bubble: '#434c5e', 'bubble-fg': '#eceff4', up: '#a3be8c', down: '#bf616a', warn: '#ebcb8b', btn: '#eceff4', 'btn-fg': '#2e3440', local: '#8fbcbb'
  }),
  t('tokyo-night', 'Tokyo Night', 'dark', {
    bg: '#1a1b26', rail: '#16161e', surface: '#1f2335', 'surface-2': '#24283b', 'surface-3': '#292e42', border: '#2c3147', muted: '#8a93bf', text: '#c0caf5',
    accent: '#7aa2f7', 'accent-fg': '#16161e', bubble: '#292e42', 'bubble-fg': '#c0caf5', up: '#9ece6a', down: '#f7768e', warn: '#e0af68', btn: '#c0caf5', 'btn-fg': '#1a1b26', local: '#7dcfff'
  }),
  t('one-dark', 'One Dark', 'dark', {
    bg: '#282c34', rail: '#21252b', surface: '#2c313a', 'surface-2': '#333842', 'surface-3': '#3e4451', border: '#3a3f4b', muted: '#8b93a1', text: '#dcdfe4',
    accent: '#61afef', 'accent-fg': '#21252b', bubble: '#333842', 'bubble-fg': '#dcdfe4', up: '#98c379', down: '#e06c75', warn: '#e5c07b', btn: '#dcdfe4', 'btn-fg': '#282c34', local: '#56b6c2'
  }),
  t('monokai', 'Monokai Pro', 'dark', {
    bg: '#2d2a2e', rail: '#221f22', surface: '#353236', 'surface-2': '#403e41', 'surface-3': '#4a474c', border: '#423f44', muted: '#939293', text: '#fcfcfa',
    accent: '#78dce8', 'accent-fg': '#221f22', bubble: '#403e41', 'bubble-fg': '#fcfcfa', up: '#a9dc76', down: '#ff6188', warn: '#ffd866', btn: '#fcfcfa', 'btn-fg': '#2d2a2e', local: '#ab9df2'
  }),
  t('rose-pine', 'Rosé Pine', 'dark', {
    bg: '#191724', rail: '#16141f', surface: '#1f1d2e', 'surface-2': '#26233a', 'surface-3': '#2f2b44', border: '#2a2740', muted: '#908caa', text: '#e0def4',
    accent: '#c4a7e7', 'accent-fg': '#191724', bubble: '#26233a', 'bubble-fg': '#e0def4', up: '#9ccfd8', down: '#eb6f92', warn: '#f6c177', btn: '#e0def4', 'btn-fg': '#191724', local: '#ebbcba'
  }),
  t('everforest', 'Everforest', 'dark', {
    bg: '#2d353b', rail: '#232a2e', surface: '#343f44', 'surface-2': '#3d484d', 'surface-3': '#475258', border: '#3f4a50', muted: '#9da9a0', text: '#d3c6aa',
    accent: '#7fbbb3', 'accent-fg': '#232a2e', bubble: '#3d484d', 'bubble-fg': '#d3c6aa', up: '#a7c080', down: '#e67e80', warn: '#dbbc7f', btn: '#d3c6aa', 'btn-fg': '#2d353b', local: '#83c092'
  })
]


export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((x) => x.id === id) ?? THEMES[0]
}

/** The theme the quick toggle switches to: the sibling, else the default of the other scheme. */
export function toggleTheme(id: string | null | undefined): ThemeId {
  const cur = themeById(id)
  return cur.pair ?? (cur.scheme === 'dark' ? 'light' : 'dark')
}
