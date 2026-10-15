import { NextResponse } from 'next/server';

// Turbopack treats the workspace root as the project root and would otherwise pick up NeedMark's own src/proxy.ts as
// this app's Next.js proxy. A pass-through proxy here takes precedence and keeps the default bundler usable.
// Turbopackはワークスペースのルートをプロジェクトのルートとみなし、NeedMark自身のsrc/proxy.tsをこのアプリのNext.jsプロキシとして
// 読み込んでしまう。ここに何もしないプロキシを置くとそちらが優先され、既定のバンドラーのまま動かせる。
export function proxy() {
  return NextResponse.next();
}
