import { Handler } from '@netlify/functions';
import OpenAI from 'openai';

const handler: Handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { 
      statusCode: 204, 
      headers, 
      body: JSON.stringify({}) // Ensure even OPTIONS returns valid JSON
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  if (!event.body) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Request body is required' }),
    };
  }

  console.log('Chat payload:', event.body);

  try {
    // Check for required environment variables
    if (!process.env.OPENAI_API_KEY) {
      console.error('Missing OPENAI_API_KEY environment variable');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'OpenAI API key is not configured. Please check your environment variables.' 
        }),
      };
    }

    if (!process.env.OPENAI_ASSISTANT_ID) {
      console.error('Missing OPENAI_ASSISTANT_ID environment variable');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'OpenAI Assistant ID is not configured. Please check your environment variables.' 
        }),
      };
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    let parsedBody;
    try {
      parsedBody = JSON.parse(event.body);
    } catch (parseError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid JSON in request body' }),
      };
    }

    const { messages } = parsedBody;
    
    if (!Array.isArray(messages)) {
      console.error('Invalid messages format:', messages);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid messages format. Expected an array.' }),
      };
    }

    const latestMessage = messages[messages.length - 1];
    if (!latestMessage || !latestMessage.content) {
      console.error('No message content provided:', latestMessage);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No message content provided.' }),
      };
    }

    // Create a thread
    const thread = await openai.beta.threads.create();
    console.log('Created thread:', thread.id);

    // Add the user's message to the thread
    const threadMessage = await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: latestMessage.content,
    });
    console.log('Added message to thread:', threadMessage.id);

    // Run the assistant with function definitions
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID,
      tools: [{
        type: 'function',
        function: {
          name: 'saveContact',
          description: 'Save user contact via Netlify function',
          parameters: {
            type: 'object',
            required: ['from_name', 'from_email', 'service_category', 'budget', 'project_details'],
            properties: {
              from_name: {
                type: 'string',
                description: 'Full name of the user'
              },
              from_email: {
                type: 'string',
                description: 'User\'s email address'
              },
              phone: {
                type: 'string',
                description: '(Optional) User\'s phone number'
              },
              service_category: {
                type: 'string',
                description: 'e.g. \'chat_inquiry\''
              },
              budget: {
                type: 'string',
                description: 'e.g. \'not_specified\''
              },
              project_details: {
                type: 'string',
                description: 'Full chat message or project details'
              },
              message: {
                type: 'string',
                description: '(Optional) Same as project_details'
              }
            }
          }
        }
      }]
    });
    console.log('Started run:', run.id);

    // Wait for the run to complete
    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    let attempts = 0;
    const maxAttempts = 30; // Maximum 30 seconds wait

    while (runStatus.status === 'queued' || runStatus.status === 'in_progress') {
      if (attempts >= maxAttempts) {
        console.error('Assistant response timeout after', maxAttempts, 'seconds');
        return {
          statusCode: 504,
          headers,
          body: JSON.stringify({ error: 'Assistant response timeout' }),
        };
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      attempts++;
      console.log('Run status check attempt', attempts, ':', runStatus.status);
    }

    console.log('Run completed with status:', runStatus.status);

    if (runStatus.status === 'completed') {
      // Get the assistant's response
      const messages = await openai.beta.threads.messages.list(thread.id);
      const lastMessage = messages.data[0];

      if (!lastMessage || !lastMessage.content[0]?.text?.value) {
        console.error('No response content from assistant');
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'No response content from assistant' }),
        };
      }

      // Check if there's a function call
      if (runStatus.required_action?.type === 'submit_tool_outputs') {
        const toolCall = runStatus.required_action.submit_tool_outputs.tool_calls[0];
        
        if (toolCall.function.name === 'saveContact') {
          const args = JSON.parse(toolCall.function.arguments);
          
          // Call the saveContact function
          const saveResponse = await fetch('/.netlify/functions/saveContact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args)
          });

          if (!saveResponse.ok) {
            console.error('Failed to save contact:', await saveResponse.text());
          }
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: lastMessage.content[0].text.value
            }
          }]
        }),
      };
    } else {
      console.error('Run failed with status:', runStatus.status);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: `Run failed with status: ${runStatus.status}` }),
      };
    }
  } catch (error) {
    console.error('Chat function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error instanceof Error 
          ? `Error processing chat request: ${error.message}` 
          : 'An unexpected error occurred while processing the chat request'
      }),
    };
  }
};

export { handler };
