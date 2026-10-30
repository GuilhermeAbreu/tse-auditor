// Tipagem mínima do Apache ECharts carregado como script global (/vendor/echarts.min.js).
declare namespace echarts {
  interface ECharts {
    setOption(opcao: Record<string, unknown>, naoMesclar?: boolean): void;
    resize(): void;
    dispose(): void;
    on(evento: string, tratador: (p: { data?: any; name?: string; seriesIndex?: number; dataIndex?: number }) => void): void;
    off(evento: string): void;
  }
  function init(el: HTMLElement, tema?: string | null, opcoes?: { renderer?: 'canvas' | 'svg'; locale?: string }): ECharts;
  function registerMap(nome: string, geoJson: unknown): void;
  function getInstanceByDom(el: HTMLElement): ECharts | undefined;
}
