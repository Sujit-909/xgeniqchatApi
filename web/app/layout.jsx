import './globals.css';

export const metadata = { title: 'Enterprise Hub', description: 'Chat, video calling and AI assistant' };
export const viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
