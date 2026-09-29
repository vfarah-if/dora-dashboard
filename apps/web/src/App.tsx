import { Route, Routes } from "react-router";
import { useMe } from "./api/hooks";
import { copy } from "./copy";
import { Header } from "./components/Header";
import { SignIn } from "./components/SignIn";
import { ErrorState, Skeleton } from "./components/States";
import { ReposPage } from "./pages/ReposPage";
import { RepoPage } from "./pages/RepoPage";
import { ComparePage } from "./pages/ComparePage";

export function App() {
  const me = useMe();

  let content;
  if (me.isPending) content = <Skeleton height={200} label={copy.auth.checking} />;
  else if (me.isError) content = <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  else if (!me.data.user) content = <SignIn auth={me.data} />;
  else
    content = (
      <Routes>
        <Route path="/" element={<ReposPage />} />
        <Route path="/repos/:id" element={<RepoPage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="*" element={<ReposPage />} />
      </Routes>
    );

  return (
    <>
      <a className="skip-link" href="#main">
        {copy.skipToContent}
      </a>
      <Header auth={me.data} />
      <main id="main" className="app-main" tabIndex={-1}>
        {content}
      </main>
    </>
  );
}
