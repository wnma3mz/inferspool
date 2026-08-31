import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "InferSpool · AI compute workspace",
  description: "管理分布式 GPU 任务与算力",
  icons: { icon: "/inferspool-logo.svg" },
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
