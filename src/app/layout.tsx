export const metadata = { title: "MangoEyes Task Hub" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 40 }}>{children}</body>
    </html>
  );
}
