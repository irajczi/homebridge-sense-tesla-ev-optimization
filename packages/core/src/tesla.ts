export interface Vehicle {
  id: string;
  vin: string;
  display_name: string;
  state: string;
}

export class TeslaClient {
  async authenticate(): Promise<void> {
    throw new Error('Not yet implemented');
  }

  async getVehicle(_vin?: string): Promise<Vehicle> {
    throw new Error('Not yet implemented');
  }

  async wakeVehicle(_id: string): Promise<void> {
    throw new Error('Not yet implemented');
  }

  async setChargingAmps(_id: string, _amps: number): Promise<void> {
    throw new Error('Not yet implemented');
  }

  async startCharging(_id: string): Promise<void> {
    throw new Error('Not yet implemented');
  }

  async stopCharging(_id: string): Promise<void> {
    throw new Error('Not yet implemented');
  }
}
