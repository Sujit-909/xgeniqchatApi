import AppProvider from '@/components/AppProvider';
import Shell from '@/components/Shell';

export default function AppLayout({ children }) {
  return (
    <AppProvider>
      <Shell>{children}</Shell>
    </AppProvider>
  );
}
