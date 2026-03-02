export const metadata = {
  title: 'Silver Mirror Virtual Assistant',
  description: 'Get help with facials, memberships, products, and skincare',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
