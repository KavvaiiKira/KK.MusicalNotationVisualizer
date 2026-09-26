import { ChangeDetectionStrategy, Component, OnDestroy, computed, signal } from '@angular/core';

type Locale = 'ru' | 'en';
const APP_TITLE = 'KK.MusicalNotationVisualizer';
const G_TO_C_FREQUENCY_RATIO = 2 ** (-5 / 12);
const C_FREQUENCY = 262;
const G_FREQUENCY = C_FREQUENCY * G_TO_C_FREQUENCY_RATIO;
const SUSTAIN_THRESHOLD = 30;
const TRAIL_SAMPLES_PER_PERIOD = 256;

function greatestCommonDivisor(first: number, second: number): number {
  while (second !== 0) {
    [first, second] = [second, first % second];
  }
  return first;
}

const translations = {
  ru: {
    subtitle: 'Два ритма · одна точка отсчёта',
    ratioLabel: 'Частоты прохождения центра за четыре тика',
    gCountLabel: 'Частота G',
    cCountLabel: 'Частота C',
    ready: 'ГОТОВО К ЗАПУСКУ',
    playing: 'СИМУЛЯЦИЯ ИДЁТ',
    start: 'Старт',
    stop: 'Стоп',
    stageLabel: 'Визуализация двух ритмов',
    linesLabel: 'Линии C и G с движущимися шариками и теневым шариком на пересечении пунктиров',
    speed: 'СКОРОСТЬ СИМУЛЯЦИИ',
    ticksUnit: 'тиков/с',
    speedLabel: 'Скорость симуляции в тиках в секунду',
    speedInputLabel: 'Введите скорость симуляции в тиках в секунду',
    volume: 'ГРОМКОСТЬ',
    volumeLabel: 'Громкость звука',
    languageLabel: 'Переключить язык на английский',
  },
  en: {
    subtitle: 'Two rhythms · one shared pulse',
    ratioLabel: 'Center crossing counts per four ticks',
    gCountLabel: 'G frequency',
    cCountLabel: 'C frequency',
    ready: 'READY TO START',
    playing: 'SIMULATION RUNNING',
    start: 'Start',
    stop: 'Stop',
    stageLabel: 'Two rhythm visualization',
    linesLabel: 'Moving C and G balls connected by dashed lines to their shared shadow ball',
    speed: 'SIMULATION SPEED',
    ticksUnit: 'ticks/s',
    speedLabel: 'Simulation speed in ticks per second',
    speedInputLabel: 'Enter simulation speed in ticks per second',
    volume: 'VOLUME',
    volumeLabel: 'Sound volume',
    languageLabel: 'Switch language to Russian',
  },
} as const;

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnDestroy {
  readonly locale = signal<Locale>('ru');
  readonly copy = computed(() => translations[this.locale()]);
  readonly cCount = signal(2);
  readonly gCount = signal(3);
  readonly ticks = signal(2);
  readonly volume = signal(50);
  readonly running = signal(false);
  readonly cPosition = signal(500);
  readonly gPosition = signal(380);
  readonly trailPath = signal('');

  private cPhase = 0;
  private gPhase = 0;
  private lastFrame = 0;
  private frameId = 0;
  private audioContext?: AudioContext;
  private sustainedC?: GainNode;
  private sustainedG?: GainNode;
  private playbackTicks = 0;
  private trailStartCPhase = 0;
  private trailStartGPhase = 0;
  private sustainedCLevel = 0;
  private sustainedGLevel = 0;

  constructor() {
    document.documentElement.lang = this.locale();
    document.title = APP_TITLE;
  }

  toggleLocale(): void {
    this.locale.set(this.locale() === 'ru' ? 'en' : 'ru');
    document.documentElement.lang = this.locale();
  }

  togglePlayback(): void {
    if (this.running()) {
      this.stopPlayback();
      return;
    }

    this.startAudio();
    this.running.set(true);
    this.lastFrame = performance.now();
    this.playbackTicks = 0;
    this.trailStartCPhase = this.cPhase;
    this.trailStartGPhase = this.gPhase;
    this.trailPath.set('');
    this.frameId = requestAnimationFrame(this.animate);
  }

  stopPlayback(): void {
    if (!this.running()) return;

    this.running.set(false);
    cancelAnimationFrame(this.frameId);
    const context = this.audioContext;
    this.audioContext = undefined;
    this.sustainedC = undefined;
    this.sustainedG = undefined;
    void context?.close();
  }

  setCount(line: 'c' | 'g', event: Event, commit = false): void {
    const input = event.target as HTMLInputElement;
    if (input.value.trim() === '') {
      if (commit) input.value = String((line === 'c' ? this.cCount : this.gCount)());
      return;
    }
    const value = Number(input.value);
    if (!Number.isFinite(value)) {
      if (commit) input.value = String((line === 'c' ? this.cCount : this.gCount)());
      return;
    }

    const count = Math.min(16, Math.max(1, Math.round(value)));
    const selectedCount = line === 'c' ? this.cCount : this.gCount;
    if (count !== selectedCount()) {
      const previousOffset = this.cPhaseOffset();
      this.lastFrame = performance.now();
      selectedCount.set(count);
      this.cPhase += previousOffset - this.cPhaseOffset();
      this.playbackTicks = 0;
      this.trailStartCPhase = this.cPhase;
      this.trailStartGPhase = this.gPhase;
      this.trailPath.set('');
    }
    this.updateBallPositions();
    if (commit) input.value = String(count);
  }

  setTicks(event: Event): void {
    const ticks = Number((event.target as HTMLInputElement).value);
    if (ticks !== this.ticks()) this.lastFrame = performance.now();
    this.ticks.set(ticks);
  }

  setTicksInput(event: Event, commit = false): void {
    const input = event.target as HTMLInputElement;
    if (input.value.trim() === '') {
      if (commit) input.value = String(this.ticks());
      return;
    }
    const value = Number(input.value);
    const ticks = Number.isFinite(value) ? Math.min(512, Math.max(2, Math.round(value))) : this.ticks();
    if (ticks !== this.ticks()) this.lastFrame = performance.now();
    this.ticks.set(ticks);
    if (commit) input.value = String(ticks);
  }

  setVolume(event: Event): void {
    this.volume.set(Number((event.target as HTMLInputElement).value));
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    void this.audioContext?.close();
  }

  private readonly animate = (now: number): void => {
    if (!this.running()) return;

    const elapsed = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    // One cycle lasts four ticks; each ratio number counts center crossings in that cycle.
    this.playbackTicks += elapsed * this.ticks();
    const nextCPhase = this.trailStartCPhase + this.playbackTicks * this.cCount() / 4;
    const nextGPhase = this.trailStartGPhase + this.playbackTicks * this.gCount() / 4;

    this.updateSustainedTones();
    this.playCrossings(C_FREQUENCY, this.cCount(), this.cPhase, nextCPhase, this.cPhaseOffset(), elapsed);
    this.playCrossings(G_FREQUENCY, this.gCount(), this.gPhase, nextGPhase, 0, elapsed);

    this.cPhase = nextCPhase;
    this.gPhase = nextGPhase;
    this.updateBallPositions();
    this.updateTrail();
    this.frameId = requestAnimationFrame(this.animate);
  };

  private cPhaseOffset(): number {
    const divisor = greatestCommonDivisor(this.cCount(), this.gCount());
    return (this.cCount() / divisor) % 2 === 1 && (this.gCount() / divisor) % 2 === 1 ? 0.5 : 0;
  }

  private updateBallPositions(): void {
    this.cPosition.set(500 + 280 * Math.sin(Math.PI * (this.cPhase + this.cPhaseOffset())));
    this.gPosition.set(380 + 280 * Math.sin(Math.PI * this.gPhase));
  }

  private updateTrail(): void {
    // Both balls return to their starting positions after this many ticks.
    const periodTicks = 8 / greatestCommonDivisor(this.cCount(), this.gCount());
    const span = Math.min(this.playbackTicks, periodTicks);
    const firstTick = this.playbackTicks - span;
    const segments = Math.max(1, Math.ceil(TRAIL_SAMPLES_PER_PERIOD * span / periodTicks));
    const cOffset = this.cPhaseOffset();
    const path: string[] = [];

    for (let index = 0; index <= segments; index++) {
      const ticks = firstTick + span * index / segments;
      const cPhase = this.trailStartCPhase + ticks * this.cCount() / 4;
      const gPhase = this.trailStartGPhase + ticks * this.gCount() / 4;
      const x = 500 + 280 * Math.sin(Math.PI * (cPhase + cOffset));
      const y = 380 + 280 * Math.sin(Math.PI * gPhase);
      path.push(`${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`);
    }

    this.trailPath.set(path.join(' '));
  }

  private startAudio(): void {
    const context = new AudioContext();
    this.audioContext = context;
    this.sustainedC = this.createSustainedTone(context, C_FREQUENCY);
    this.sustainedG = this.createSustainedTone(context, G_FREQUENCY);
    this.sustainedCLevel = 0;
    this.sustainedGLevel = 0;
    void context.resume();
  }

  private createSustainedTone(context: AudioContext, frequency: number): GainNode {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    return gain;
  }

  private updateSustainedTones(): void {
    const context = this.audioContext;
    if (!context) return;

    const level = (this.volume() / 100) * 0.09;
    const cLevel = this.ticks() * this.cCount() / 4 >= SUSTAIN_THRESHOLD ? level : 0;
    const gLevel = this.ticks() * this.gCount() / 4 >= SUSTAIN_THRESHOLD ? level : 0;
    if (cLevel !== this.sustainedCLevel) {
      this.sustainedC?.gain.setTargetAtTime(cLevel, context.currentTime, 0.02);
      this.sustainedCLevel = cLevel;
    }
    if (gLevel !== this.sustainedGLevel) {
      this.sustainedG?.gain.setTargetAtTime(gLevel, context.currentTime, 0.02);
      this.sustainedGLevel = gLevel;
    }
  }

  private playCrossings(frequency: number, count: number, previous: number, next: number, offset: number, elapsed: number): void {
    const crossingRate = this.ticks() * count / 4;
    if (crossingRate >= SUSTAIN_THRESHOLD) return;

    const crossings = Math.floor(next + offset) - Math.floor(previous + offset);
    const duration = Math.min(0.24, Math.max(0.06, (1 / crossingRate) * 0.55));

    for (let index = 0; index < crossings; index++) {
      this.playTone(frequency, duration, (index / crossings) * elapsed);
    }
  }

  private playTone(frequency: number, duration: number, delay: number): void {
    const context = this.audioContext;
    if (!context || context.state !== 'running' || this.volume() === 0) return;

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + delay;
    const level = (this.volume() / 100) * 0.16;

    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    const attack = Math.min(0.018, duration * 0.25);
    const release = Math.min(0.09, duration * 0.5);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + attack);
    gain.gain.setValueAtTime(level, start + duration - release);
    gain.gain.linearRampToValueAtTime(0, start + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }
}
