declare module '@tauri-apps/api/dialog' {
  interface DialogFilter {
    name: string
    extensions: string[]
  }

  interface OpenDialogOptions {
    title?: string
    defaultPath?: string
    multiple?: boolean
    directory?: boolean
    filters?: DialogFilter[]
  }

  export function open(options?: OpenDialogOptions): Promise<string | string[] | null>
}

declare module '@tauri-apps/api/shell' {
  type ShellTarget = string | { program: string; args?: string[] } | { path: string; args?: string[] }

  export function open(target: ShellTarget): Promise<void>
}

declare module '@tauri-apps/api/fs' {
  export function readBinaryFile(path: string): Promise<any>
  export function writeBinaryFile(options: { path: string; contents: any }): Promise<void>
  export function writeTextFile(path: string, contents: string): Promise<void>
  export function writeTextFile(options: { path: string; contents: string }): Promise<void>
  export function createDir(path: string, options?: { recursive?: boolean }): Promise<void>
}

declare module '@tauri-apps/api/path' {
  export function basename(path: string): Promise<string>
  export function extname(path: string): Promise<string>
  export function join(...segments: string[]): Promise<string>
}

declare module '@tauri-apps/api/core' {
  export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
}
