import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import User from '../models/User.js';
import Room from '../models/Room.js';
import Message from '../models/Message.js';
import { connectDB } from '../config/db.js';

dotenv.config();

const SEED_PASSWORD = 'password123';

const seedDatabase = async () => {
  try {
    // 1. Connect to your database
    await connectDB();
    console.log('Connected to Database. Pre-clearing old data...');

    // 2. Clear old data to prevent duplicate index crashes
    await User.deleteMany({});
    await Room.deleteMany({});
    await Message.deleteMany({});
    console.log('Database cleared.');

    // 3. Hash passwords
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(SEED_PASSWORD, salt);

    // 4. Create Manager One & Manager Two
    const manager1 = await User.create({
      name: 'Manager One',
      phone: '9000000001',
      password: hashedPassword,
      role: 'manager'
    });

    const manager2 = await User.create({
      name: 'Manager Two',
      phone: '9000000002',
      password: hashedPassword,
      role: 'manager'
    });

    console.log(`Created Managers: \n- ${manager1.name} (_id: ${manager1._id})\n- ${manager2.name} (_id: ${manager2._id})`);

    // 5. Build arrays for assigning Drivers
    const driversToCreate = [
      // Manager 1's 5 Drivers
      { name: 'Alex', phone: '8000000011', managerId: manager1._id },
      { name: 'Ben', phone: '8000000012', managerId: manager1._id },
      { name: 'Charlie', phone: '8000000013', managerId: manager1._id },
      { name: 'Daniel', phone: '8000000014', managerId: manager1._id },
      { name: 'Ethan', phone: '8000000015', managerId: manager1._id },

      // Manager 2's 3 Drivers
      { name: 'Frank', phone: '8000000021', managerId: manager2._id },
      { name: 'George', phone: '8000000022', managerId: manager2._id },
      { name: 'Harry', phone: '8000000023', managerId: manager2._id },
    ];

    // 6. Pre-provision the Shared Community Hub Room
    const communityRoom = await Room.create({
      type: 'community',
      participants: []
    });
    console.log(`Community Hub Created: _id ${communityRoom._id}`);

    // 7. Insert drivers and generate private room bindings
    for (const driverData of driversToCreate) {
      const driver = await User.create({
        name: driverData.name,
        phone: driverData.phone,
        password: hashedPassword,
        role: 'driver',
        managerId: driverData.managerId
      });

      // Create 1-on-1 Room between the Driver and their specific Manager
      await Room.create({
        type: 'personal',
        participants: [driverData.managerId, driver._id]
      });

      console.log(`Created Driver ${driver.name} under ${driverData.managerId === manager1._id ? 'Manager One' : 'Manager Two'}`);
    }

    console.log('\n=============================================');
    console.log('✅ DATABASE SUCCESSFULLY SEEDED WITH SAMPLE SPACE!');
    console.log('Use password "password123" for any account.');
    console.log('=============================================');

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('Seeding Failed:', error);
    process.exit(1);
  }
};

seedDatabase();