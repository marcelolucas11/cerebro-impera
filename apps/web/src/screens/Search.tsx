import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { api } from '../api.js';
import { toSearch, NO_FILTER, DEFAULT_SORT } from '../filters.js';
import { formatWhen } from '../labels.js';
import { describeError } from '../messages.js';
import { Link, navigate, useQueryString } from '../router.js';
import { Notice } from '../ui/kit.js';

/** Where a search goes. */
export const searchPath = (q: string): string => `/busca?${new URLSearchParams({ q }).toString()}`;

/** The search box in the top bar: the same on every screen. */
export function SearchBox(): ReactNode {
  const id = useId();
  const current = new URLSearchParams(useQueryString()).get('q') ?? '';
  const [text, setText] = useState(current);
  const go = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (text.trim().length >= 2) navigate(searchPath(text.trim()));
  };
  return (
    <form
      className="shell-search"
      role="search"
      aria-label="Buscar em todas as listas"
      onSubmit={go}
    >
      <label htmlFor={id} className="visually-hidden">
        Buscar em todas as listas
      </label>
      <input
        id={id}
        type="search"
        placeholder="Buscar"
        value={text}
        maxLength={100}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
    </form>
  );
}

/*
 * Results from every list the person can open, titles first. A result opens
 * its list narrowed to that title.
 */
export function Search(): ReactNode {
  const q = (new URLSearchParams(useQueryString()).get('q') ?? '').trim();
  const results = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.search(q),
    enabled: q.length >= 2,
  });
  return (
    <>
      <h1>Busca</h1>
      {q.length < 2 ? (
        <p className="lead">Digite pelo menos duas letras na busca, no alto da página.</p>
      ) : null}
      {results.isError ? <Notice tone="error">{describeError(results.error)}</Notice> : null}
      {results.isPending && q.length >= 2 ? <p className="lead">Buscando…</p> : null}
      {results.data ? (
        <>
          <p className="lead" role="status">
            {results.data.length === 0
              ? `Nada encontrado para “${q}” nas listas que você abre.`
              : `${results.data.length === 30 ? 'Os 30 primeiros resultados' : `${results.data.length} ${results.data.length === 1 ? 'resultado' : 'resultados'}`} para “${q}”.`}
          </p>
          <ul className="rows search-results">
            {results.data.map((hit) => (
              <li key={hit.id}>
                <span>
                  <Link
                    to={`/listas/${hit.listId}${toSearch({ ...NO_FILTER, text: hit.title }, DEFAULT_SORT)}`}
                    current={false}
                  >
                    {hit.title}
                  </Link>
                  {hit.inTitle ? null : <span className="tag">na descrição</span>}
                </span>
                <span className="muted">
                  {hit.listName}, {hit.stageName}, mudou em {formatWhen(hit.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
          <p className="field-note">
            A busca procura nos títulos e nas descrições dos itens que você pode abrir. Listas
            sensíveis só entram depois de confirmar o código nelas.
          </p>
        </>
      ) : null}
    </>
  );
}
