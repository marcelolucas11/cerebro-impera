import {
  BRAND_SURFACE,
  brandColorProblem,
  contrast,
  DEFAULT_BRAND_COLOR,
  inkOn,
  MIN_BRAND_CONTRAST,
  type Brand as BrandView,
  type BrandImageKind,
  type SaveBrand,
} from '@cerebro/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { api } from '../api.js';
import { drawLogo, iconAddress, LOGO_PROBLEMS, LOGO_TYPES, type DrawnLogo } from '../brand.js';
import { describeError } from '../messages.js';
import { useGuard } from '../stepup.js';
import { Button, Field, Form, Notice, useAction } from '../ui/kit.js';

/*
 * The installation's brand: name, color and logo. Everyone sees it, starting
 * with the sign-in page, so the page says so. The logo is drawn here into the
 * three icons; the file picked never leaves the device.
 */

type Logo = 'keep' | null | DrawnLogo;

const ICONS: { kind: BrandImageKind; label: string; round?: boolean }[] = [
  { kind: 'icon-192', label: 'No menu e na aba' },
  { kind: 'icon-512', label: 'No aplicativo instalado' },
  { kind: 'maskable-512', label: 'Recortado pelo celular', round: true },
];

/**
 * A drawn icon, shown as it is: no address, so nothing for the page's rules to
 * refuse. Each place gets its own copy, since one canvas can only be in one place.
 */
function Drawn({ canvas }: { canvas: HTMLCanvasElement }): ReactNode {
  const holder = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = holder.current;
    if (element === null) return undefined;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d')?.drawImage(canvas, 0, 0);
    element.replaceChildren(copy);
    return () => {
      element.replaceChildren();
    };
  }, [canvas]);
  return <span ref={holder} className="brand-icon-drawn" />;
}

function colorText(color: string | null): string {
  return color ?? DEFAULT_BRAND_COLOR;
}

export function BrandForm({
  initial,
  save,
  onSaved,
  submitLabel,
  secondary,
}: {
  initial: BrandView;
  save: (input: SaveBrand) => Promise<BrandView>;
  onSaved: (brand: BrandView) => void;
  submitLabel: string;
  /** Another way out, beside saving (in the installation: keeping the project's brand). */
  secondary?: ReactNode;
}): ReactNode {
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState<string | null>(initial.color);
  const [typed, setTyped] = useState(colorText(initial.color));
  const [logo, setLogo] = useState<Logo>('keep');
  const [logoProblem, setLogoProblem] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);

  const shown = color ?? DEFAULT_BRAND_COLOR;
  const problem = brandColorProblem(shown);
  const hasLogo = logo === 'keep' ? initial.logo !== null : logo !== null;

  const pickColor = (value: string): void => {
    const clean = value.trim().toLowerCase();
    setTyped(clean);
    if (/^#[0-9a-f]{6}$/.test(clean)) setColor(clean === DEFAULT_BRAND_COLOR ? null : clean);
  };

  const pickLogo = (file: File | undefined): void => {
    if (file === undefined) return;
    setDrawing(true);
    setLogoProblem(null);
    void drawLogo(file)
      .then((drawn) => {
        if (typeof drawn === 'string') setLogoProblem(LOGO_PROBLEMS[drawn]);
        else setLogo(drawn);
      })
      .finally(() => {
        setDrawing(false);
      });
  };

  const submit = useAction(
    useCallback(async () => {
      const saved = await save({
        name: name.trim(),
        color,
        logo: logo === 'keep' || logo === null ? logo : logo.files,
      });
      onSaved(saved);
    }, [save, onSaved, name, color, logo]),
  );

  const typedValid = /^#[0-9a-f]{6}$/.test(typed);
  const colorError = !typedValid
    ? 'Escreva a cor como # seguido de 6 dígitos, por exemplo #6fb3e0.'
    : problem === 'too_dark'
      ? `Essa cor some no fundo escuro do aplicativo: o contraste fica em ${contrast(shown, BRAND_SURFACE).toFixed(1).replace('.', ',')} para 1, e o mínimo para ler é ${String(MIN_BRAND_CONTRAST).replace('.', ',')}. Escolha uma mais clara.`
      : undefined;
  const ready = name.trim() !== '' && typedValid && problem === null && !drawing;
  const preview = { '--marca': shown, '--sobre-marca': inkOn(shown) } as CSSProperties;

  return (
    <Form onSubmit={submit.run}>
      <Field
        label="Nome da empresa"
        value={name}
        maxLength={80}
        autoComplete="organization"
        onChange={(event) => {
          setName(event.target.value);
        }}
      />

      <fieldset className="brand-group">
        <legend>Cor da marca</legend>
        <div className="brand-color">
          <Field
            label="Escolher"
            type="color"
            value={shown}
            onChange={(event) => {
              pickColor(event.target.value);
            }}
          />
          <Field
            label="Código da cor"
            className="exact-input"
            value={typed}
            maxLength={7}
            spellCheck={false}
            error={colorError}
            onChange={(event) => {
              pickColor(event.target.value);
            }}
          />
        </div>
        {color !== null ? (
          <Button
            variant="quiet"
            onClick={() => {
              setColor(null);
              setTyped(DEFAULT_BRAND_COLOR);
            }}
          >
            Voltar à cor de fábrica
          </Button>
        ) : null}
      </fieldset>

      <fieldset className="brand-group">
        <legend>Logo</legend>
        <Field
          label="Arquivo do logo"
          type="file"
          accept={LOGO_TYPES.join(',')}
          hint="PNG, JPEG ou WebP. O símbolo sozinho, sem o nome escrito, fica melhor nos ícones. O aplicativo ajusta o logo aos tamanhos de ícone, e só esses ícones saem deste aparelho."
          error={logoProblem ?? undefined}
          onChange={(event) => {
            pickLogo(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        {drawing ? <p className="field-note">Ajustando o logo…</p> : null}
        <ul className="brand-icons" aria-label="Como o logo aparece">
          {ICONS.map(({ kind, label, round }) => (
            <li key={kind} className={round ? 'brand-icon brand-icon-round' : 'brand-icon'}>
              {logo !== null && logo !== 'keep' ? (
                <Drawn canvas={logo.canvases[kind]} />
              ) : (
                <img
                  src={iconAddress(logo === null ? { logo: null } : initial, kind)}
                  alt=""
                  width={96}
                  height={96}
                />
              )}
              <span>{label}</span>
            </li>
          ))}
        </ul>
        {hasLogo ? (
          <Button
            variant="quiet"
            onClick={() => {
              setLogo(null);
            }}
          >
            Voltar ao logo de fábrica
          </Button>
        ) : null}
      </fieldset>

      <section className="brand-preview" style={preview} aria-label="Prévia da marca">
        <p className="brand-preview-bar">
          {logo !== null && logo !== 'keep' ? (
            <Drawn canvas={logo.canvases['icon-192']} />
          ) : (
            <img
              src={iconAddress(logo === null ? { logo: null } : initial)}
              alt=""
              width={28}
              height={28}
            />
          )}
          <span>{name.trim() === '' ? 'Nome da empresa' : name}</span>
        </p>
        <p className="brand-preview-body">
          <span className="brand-preview-button">Botão principal</span>
          <span className="brand-preview-mark">Item em destaque</span>
        </p>
      </section>

      {submit.error ? <Notice tone="error">{submit.error}</Notice> : null}
      <div className="brand-actions">
        <Button type="submit" busy={submit.busy} disabled={!ready}>
          {submitLabel}
        </Button>
        {secondary}
      </div>
    </Form>
  );
}

/** The page, for whoever may configure the system. */
export function Brand(): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const brand = useQuery({ queryKey: ['brand'], queryFn: api.brand });
  const [saved, setSaved] = useState(false);

  const save = useCallback((input: SaveBrand) => guard(() => api.saveBrand(input)), [guard]);
  const onSaved = useCallback(
    (next: BrandView) => {
      queryClient.setQueryData(['brand'], next);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      setSaved(true);
    },
    [queryClient],
  );

  if (brand.isPending) return <p className="lead">Abrindo…</p>;
  if (brand.isError) return <Notice tone="error">{describeError(brand.error)}</Notice>;
  const current = brand.data;

  return (
    <div className="brand">
      <h1>Marca</h1>
      <p className="lead">
        O nome, a cor e o logo que todos veem, inclusive na tela de entrada, antes da senha. Não
        ponha aqui nada que não possa ser público.
      </p>
      {saved ? (
        <Notice tone="ok">Marca salva. Quem abrir o aplicativo agora já vê a nova.</Notice>
      ) : null}
      <BrandForm
        key={`${current.name}|${current.color ?? ''}|${current.logo ?? ''}`}
        initial={current}
        save={save}
        onSaved={onSaved}
        submitLabel="Salvar marca"
      />
    </div>
  );
}
