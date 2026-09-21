import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "听见 · 总结｜B站视频内容提炼",
  description: "粘贴 B 站视频链接，免费本地转写并生成结构化内容总结。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
