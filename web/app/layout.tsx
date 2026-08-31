import type { Metadata } from "next";
import "./globals.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const metadata: Metadata = {
  title: "InferSpool · 闲置 GPU 任务队列",
  description: "把 AI 任务发往闲置 GPU，无需开放入站端口",
  icons: { icon: `${basePath}/inferspool-logo.svg` },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html:
              `(function(){try{var t=localStorage.getItem('inferspool-theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';document.documentElement.style.colorScheme=d?'dark':'light'}catch(e){}})()`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
