import { EventEmitter } from 'events';
import { AppConfig } from './config.js';
import { SenseClient } from './sense.js';
import { TeslaClient } from './tesla.js';

export class SolarChargeController extends EventEmitter {
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly sense: SenseClient,
    private readonly tesla: TeslaClient,
  ) {
    super();
  }

  start(): void {
    throw new Error('Not yet implemented');
  }

  stop(): void {
    throw new Error('Not yet implemented');
  }

  isRunning(): boolean {
    return this.running;
  }
}
