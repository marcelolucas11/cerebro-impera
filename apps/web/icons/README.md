# Ícones do aplicativo instalado

Fontes dos PNGs em `public/icons/`. Para gerar de novo depois de mudar um SVG:

```sh
rsvg-convert -w 192 -h 192 icons/icon.svg -o public/icons/icon-192.png
rsvg-convert -w 512 -h 512 icons/icon.svg -o public/icons/icon-512.png
rsvg-convert -w 512 -h 512 icons/maskable.svg -o public/icons/maskable-512.png
rsvg-convert -w 180 -h 180 icons/maskable.svg -o public/icons/apple-touch-180.png
```

`maskable.svg` tem o desenho dentro da área segura (o sistema pode recortar o ícone em círculo).
A marca de cada empresa entra pelo assistente de instalação (Fase 10).
