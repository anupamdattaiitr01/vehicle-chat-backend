import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js'; // Ensure .js extension

// In production, this must come from your .env file
const JWT_SECRET = process.env.JWT_SECRET || 'fleet_super_secret_key_2026';

export const registerUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, phone, password, role, managerId } = req.body;

    // 1. Check if the phone number is already registered
    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      res.status(400).json({ error: 'Phone number is already registered' });
      return;
    }

    // 2. Hash the password for security
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 3. Create the user
    const newUser = await User.create({
      name,
      phone,
      password: hashedPassword,
      role,
      managerId: role === 'driver' ? managerId : undefined,
    });

    res.status(201).json({ 
      message: 'User registered successfully', 
      userId: newUser._id 
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
};

export const loginUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone, password } = req.body;

    // 1. Find the user by their phone number
    const user = await User.findOne({ phone });
    if (!user) {
      res.status(400).json({ error: 'Invalid phone number or password' });
      return;
    }

    // 2. Compare the provided password with the hashed password in the database
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      res.status(400).json({ error: 'Invalid phone number or password' });
      return;
    }

    // 3. Generate a JSON Web Token valid for 7 days
    const token = jwt.sign(
      { userId: user._id, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // 4. Send the token and user data back to the React/Flutter app
    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        _id: user._id,
        name: user.name,
        role: user.role,
        phone: user.phone,
        managerId: user.managerId,
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to log in' });
  }
};