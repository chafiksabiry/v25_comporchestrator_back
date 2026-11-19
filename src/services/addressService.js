import { config } from '../config/env.js';
import axios from 'axios';

class AddressService {
  constructor() {
    if (!config.telnyxApiKey) {
      throw new Error('TELNYX_API_KEY is not defined');
    }
    
    this.axiosInstance = axios.create({
      baseURL: 'https://api.telnyx.com/v2',
      headers: {
        'Authorization': `Bearer ${config.telnyxApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
  }

  async createBusinessAddress({
    businessName,
    streetAddress,
    locality,
    postalCode,
    countryCode,
    extendedAddress = null,
    administrativeArea = null,
    customerReference = null
  }) {
    try {
      console.log('📍 Creating Telnyx business address:', {
        businessName,
        streetAddress,
        locality,
        postalCode,
        countryCode
      });

      const addressData = {
        business_name: businessName,
        street_address: streetAddress,
        locality,
        postal_code: postalCode,
        country_code: countryCode
      };

      // Ajouter les champs optionnels s'ils sont fournis
      if (extendedAddress) {
        addressData.extended_address = extendedAddress;
      }
      
      if (administrativeArea) {
        addressData.administrative_area = administrativeArea;
      }

      // Ajouter customer_reference seulement s'il est fourni
      if (customerReference) {
        addressData.customer_reference = customerReference;
      }

      const response = await this.axiosInstance.post('/addresses', addressData);
      
      console.log('✅ Telnyx address created:', response.data.data);
      
      return {
        id: response.data.data.id,
        businessName: response.data.data.business_name,
        streetAddress: response.data.data.street_address,
        extendedAddress: response.data.data.extended_address,
        locality: response.data.data.locality,
        administrativeArea: response.data.data.administrative_area,
        postalCode: response.data.data.postal_code,
        countryCode: response.data.data.country_code,
        customerReference: response.data.data.customer_reference,
        recordType: response.data.data.record_type,
        createdAt: response.data.data.created_at
      };
    } catch (error) {
      console.error('❌ Error creating Telnyx address:', error.response?.data || error);
      throw error;
    }
  }

  /** Supprime une adresse chez l'opérateur (nettoyage au mieux quand la propriété n'a pas pu être enregistrée). */
  async deleteAddress(addressId) {
    await this.axiosInstance.delete(`/addresses/${addressId}`);
    return { success: true };
  }

  async retrieveAddress(addressId) {
    try {
      console.log(`📍 Retrieving Telnyx address: ${addressId}`);
      
      const response = await this.axiosInstance.get(`/addresses/${addressId}`);
      
      console.log('✅ Address retrieved:', response.data.data);
      
      return {
        id: response.data.data.id,
        businessName: response.data.data.business_name,
        streetAddress: response.data.data.street_address,
        extendedAddress: response.data.data.extended_address,
        locality: response.data.data.locality,
        administrativeArea: response.data.data.administrative_area,
        postalCode: response.data.data.postal_code,
        countryCode: response.data.data.country_code,
        customerReference: response.data.data.customer_reference,
        recordType: response.data.data.record_type,
        createdAt: response.data.data.created_at
      };
    } catch (error) {
      console.error(`❌ Error retrieving address ${addressId}:`, error.response?.data || error);
      throw error;
    }
  }
}

export const addressService = new AddressService();