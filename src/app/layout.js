export const metadata = {
  title: 'Silver Mirror Membership Assistant',
  description: 'Talk to us about your membership',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
