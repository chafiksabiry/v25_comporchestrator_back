import { phoneNumberService } from '../services/phoneNumberService.js';
import { config } from '../config/env.js';

class PhoneNumberController {
  async searchNumbers(req, res) {
    try {
      const { countryCode, type, features } = req.query;
      console.log(countryCode, type, features);
      const numbers = await phoneNumberService.searchAvailableNumbers({
        countryCode,
        type,
        features
      });
      res.json(numbers);
    } catch (error) {
      console.error('Error searching phone numbers:', error);
      res.status(500).json({ error: 'Failed to search phone numbers' });
    }
  }

  async searchTwilioNumbers(req, res) {
    try {
      const { countryCode, areaCode, limit } = req.query;
      console.log("countryCode",countryCode);
      console.log("areaCode",areaCode);
      console.log("limit",limit);
      const numbers = await phoneNumberService.searchTwilioNumbers({
        countryCode: countryCode || 'US',
        areaCode,
        limit: parseInt(limit) || 10
      });
      res.json(numbers);
    } catch (error) {
      console.error('Error searching Twilio phone numbers:', error);
      res.status(500).json({ error: 'Failed to search Twilio phone numbers' });
    }
  }

  async purchaseNumber(req, res) {
    try {
      const { phoneNumber, provider, gigId } = req.body;
      const newNumber = await phoneNumberService.purchaseNumber(
        phoneNumber,
        provider,
        gigId,
        config.telnyxConnectionId,
        config.telnyxMessagingProfileId,
        config.baseUrl
      );
      res.json(newNumber);
    } catch (error) {
      console.error('Error purchasing phone number:', error);
      res.status(500).json({ error: 'Failed to purchase phone number' });
    }
  }

  async purchaseTwilioNumber(req, res) {
    try {
      const { phoneNumber, gigId } = req.body;
      console.log("phoneNumber", phoneNumber);

      // Check if gig already has a phone number
      const existingNumber = await phoneNumberService.getPhoneNumbersByGigId(gigId);
      if (existingNumber && existingNumber.length > 0) {
        return res.status(400).json({ 
          error: 'This gig already has a phone number assigned'
        });
      }

      const newNumber = await phoneNumberService.purchaseTwilioNumber(
        phoneNumber,
        config.baseUrl,
        gigId
      );
      console.log("newNumber", newNumber);
      res.json(newNumber);
    } catch (error) {
      console.error('Error purchasing Twilio phone number:', error);
      res.status(500).json({ error: 'Failed to purchase Twilio phone number' });
    }
  }

  async getAllNumbers(req, res) {
    try {
      const numbers = await phoneNumberService.getAllPhoneNumbers();
      res.json(numbers);
    } catch (error) {
      console.error('Error fetching phone numbers:', error);
      res.status(500).json({ error: 'Failed to fetch phone numbers' });
    }
  }

  async getNumbersByGigId(req, res) {
    try {
      const { gigId } = req.params;
      const numbers = await phoneNumberService.getPhoneNumbersByGigId(gigId);
      res.json(numbers);
    } catch (error) {
      console.error('Error fetching phone numbers by gigId:', error);
      res.status(500).json({ error: 'Failed to fetch phone numbers by gigId' });
    }
  }

  async deleteNumber(req, res) {
    try {
      const result = await phoneNumberService.deletePhoneNumber(req.params.id);
      res.json(result);
    } catch (error) {
      console.error('Error deleting phone number:', error);
      if (error.message === 'Phone number not found') {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to delete phone number' });
      }
    }
  }
}

export const phoneNumberController = new PhoneNumberController(); 