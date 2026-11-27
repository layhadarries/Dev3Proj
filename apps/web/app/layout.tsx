import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "SolGuard", description: "Check a Solana Devnet transfer before you sign it" };

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
