import "./globals.css";
import ThemeSwitch from "../components/ThemeSwitch";

export const metadata = {
  title: "Tanzania Judgments Explorer",
  description: "Search and chat with Tanzanian court judgments",
};

// Apply theme before React hydrates: prefer cookie, then localStorage, else 'light'
const initTheme = `(function(){try{
  var m = document.cookie.match(/(?:^|; )theme=([^;]+)/);
  var t = m ? decodeURIComponent(m[1]) : (localStorage.getItem('theme') || 'light');
  document.documentElement.setAttribute('data-theme', t);
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Don't render data-theme on the server; let the script set it pre-hydration
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Prevent theme flash & ensure first paint matches client */}
        <script dangerouslySetInnerHTML={{ __html: initTheme }} />
      </head>
      <body>
  {/* Float on desktop only */}
  <div className="hidden md:block fixed right-4 top-4 z-50">
    <ThemeSwitch />
  </div>
  {children}
</body>
    </html>
  );
}
