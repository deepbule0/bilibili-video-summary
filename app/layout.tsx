import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "听见 · 总结｜B站视频智能转写与总结",
  description: "粘贴 B 站视频链接，生成完整内容总结、关键洞察、时间线和原始转写。新用户可免费试用30分钟。",
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
